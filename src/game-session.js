/**
 * Amaral Boost — Modo durante o jogo.
 *
 * Liga/desliga e supervisiona um PowerShell auxiliar de longa duração que
 * compila game-session-engine.cs e roda um Tick a cada 2 s. O trabalho de
 * verdade (detectar o jogo em primeiro plano, prioridade, EcoQoS, restaurar)
 * está todo no .cs — ver o comentário do topo dele para as regras.
 *
 * Diferente do limite de RAM (ram-limit.js), o auxiliar é filho direto do
 * Electron, não uma Tarefa Agendada: o modo só faz sentido com o app aberto.
 * Três camadas garantem que nada fique alterado quando o app sai:
 *   1. "stop" pela entrada padrão → o auxiliar restaura tudo e encerra;
 *   2. o auxiliar confere a cada Tick se o processo do app ainda existe;
 *   3. o que foi alterado fica num arquivo de recuperação, lido na próxima
 *      execução (inclusive se o modo tiver sido desligado nesse meio tempo).
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const gaming = require('./gaming');

const execFileAsync = promisify(execFile);
const TICK_STALE_MS = 15000;
const GAMES_REFRESH_MS = 5 * 60 * 1000;
const STOP_TIMEOUT_MS = 6000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
// Mesmo jogo voltando ao primeiro plano (alt-tab) não gera outra entrada no
// histórico antes disso.
const HISTORY_REPEAT_MS = 10 * 60 * 1000;

// Apps que não gerenciam o próprio QoS e não participam do jogo. Fora de
// propósito: Steam (o overlay do jogo roda no steamwebhelper), Discord e
// Spotify (voz e áudio), Firefox (já usa EcoQoS nos próprios processos).
const BACKGROUND_APPS = [
  'OneDrive', 'Dropbox', 'GoogleDriveFS',
  'EpicGamesLauncher', 'EpicWebHelper', 'Battle.net', 'EADesktop', 'upc', 'GalaxyClient'
];
// Destes, só processos de extensão entram (ver IsChromiumExtension no .cs).
const CHROMIUM_BROWSERS = ['chrome', 'msedge', 'brave', 'opera', 'opera_gx', 'vivaldi'];

const files = {
  state: () => path.join(app.getPath('userData'), 'amaral-boost-game-session.json'),
  engine: () => path.join(app.getPath('userData'), 'amaral-boost-game-session-engine.cs'),
  helper: () => path.join(app.getPath('userData'), 'amaral-boost-game-session-helper.ps1'),
  config: () => path.join(app.getPath('userData'), 'amaral-boost-game-session-config.json'),
  recovery: () => path.join(app.getPath('userData'), 'amaral-boost-game-session-recovery.txt')
};

// Sem crases nem ${} de propósito: o script é montado como texto simples.
const HELPER_SCRIPT = [
  'param([string]$EnginePath, [string]$ConfigPath, [string]$RecoveryPath, [int]$ParentPid)',
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  'function Emit([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }',
  'try {',
  '  Add-Type -TypeDefinition ([IO.File]::ReadAllText($EnginePath))',
  '  $recovered = [AmaralGameSession]::Recover($RecoveryPath)',
  "  Emit ('{\"type\":\"ready\",\"recovered\":' + $recovered + '}')",
  '  [AmaralGameSession]::WatchStdin()',
  '  $stamp = 0L; $last = \'\'',
  '  while (-not [AmaralGameSession]::StopRequested) {',
  '    if (-not [AmaralGameSession]::IsAlive($ParentPid)) { break }',
  '    $now = [IO.File]::GetLastWriteTimeUtc($ConfigPath).Ticks',
  '    if ($now -ne $stamp) {',
  '      $cfg = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json',
  '      $games = @($cfg.games)',
  '      [AmaralGameSession]::Configure([string[]]@($games | ForEach-Object { $_.path }), [string[]]@($games | ForEach-Object { $_.kind }), [string[]]@($games | ForEach-Object { $_.name }), [string[]]@($cfg.background), [string[]]@($cfg.chromium), $RecoveryPath)',
  '      $stamp = $now',
  '    }',
  '    $status = [AmaralGameSession]::Tick(0)',
  "    Emit ('{\"type\":\"tick\"}')",
  '    if ($status -ne $last) { Emit $status; $last = $status }',
  // 10 x 200 ms em vez de 2 s direto: um "stop" é atendido em até 200 ms.
  '    for ($i = 0; $i -lt 10 -and -not [AmaralGameSession]::StopRequested; $i++) { Start-Sleep -Milliseconds 200 }',
  '  }',
  '} catch {',
  "  Emit ('{\"type\":\"error\",\"message\":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')",
  '} finally {',
  '  try { [AmaralGameSession]::RestoreAll() } catch {}',
  "  Emit '{\"type\":\"stopped\"}'",
  '}'
].join('\r\n');

let child = null;
let stopping = null;
let buffer = '';
let restarts = [];
let refreshTimer = null;
let recordHistory = async () => {};
let lastHistory = { game: '', at: 0 };
// `ticks` conta Ticks de verdade do auxiliar: "processo existe" não prova que o
// loop está rodando (foi exatamente assim que um travamento passou despercebido).
const live = { enabled: false, running: false, inGame: false, game: '', priority: 'none', throttled: 0, ticks: 0, lastTickAt: 0, error: null };

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(files.state(), 'utf8'));
    return { enabled: parsed?.enabled === true };
  } catch {
    return { enabled: false };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(files.state()), { recursive: true });
  await fs.writeFile(files.state(), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function buildConfig() {
  const list = await gaming.listGames().catch(() => ({ games: [] }));
  const games = [];
  for (const game of list.games || []) {
    if (game.installDir) games.push({ kind: 'dir', path: game.installDir, name: game.name });
    else if (game.exists) games.push({ kind: 'exe', path: game.exePath, name: game.name });
  }
  return { games, background: BACKGROUND_APPS, chromium: CHROMIUM_BROWSERS };
}

async function writeConfig() {
  const next = JSON.stringify(await buildConfig(), null, 2);
  const current = await fs.readFile(files.config(), 'utf8').catch(() => null);
  // Só grava quando muda: o auxiliar relê o arquivo pela data de modificação.
  if (current !== next) await fs.writeFile(files.config(), next, 'utf8');
}

// O .cs vive dentro do app.asar, que o PowerShell não enxerga: vai uma cópia
// para a pasta de dados do usuário a cada início.
async function writeRuntimeFiles() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(files.engine(), await fs.readFile(path.join(__dirname, 'game-session-engine.cs'), 'utf8'), 'utf8');
  await fs.writeFile(files.helper(), HELPER_SCRIPT, 'utf8');
  await writeConfig();
}

function priorityText(priority) {
  if (priority === 'high') return 'prioridade alta no jogo';
  if (priority === 'already') return 'o jogo já estava em prioridade alta';
  if (priority === 'denied') return 'o jogo não permite mudar a prioridade (comum com anti-cheat)';
  return 'prioridade do jogo inalterada';
}

function handleMessage(message) {
  if (message.type === 'tick') { live.lastTickAt = Date.now(); live.ticks++; return; }
  if (message.type === 'ready') {
    if (message.recovered > 0) {
      recordHistory('Modo durante o jogo: sessão interrompida restaurada', true, `${message.recovered} alteração(ões) de uma sessão que não terminou direito foram desfeitas.`).catch(() => {});
    }
    return;
  }
  if (message.type === 'error') { live.error = message.message || 'O modo durante o jogo encontrou um erro.'; return; }
  if (message.type !== 'status') return;

  const entered = message.inGame && (!live.inGame || live.game !== message.game);
  Object.assign(live, { inGame: Boolean(message.inGame), game: message.game || '', priority: message.priority || 'none', throttled: Number(message.throttled) || 0, error: null });
  if (entered) {
    const now = Date.now();
    if (lastHistory.game !== live.game || now - lastHistory.at > HISTORY_REPEAT_MS) {
      lastHistory = { game: live.game, at: now };
      recordHistory(`Modo durante o jogo: ${live.game}`, true, `Em primeiro plano: ${priorityText(live.priority)}; ${live.throttled} processo(s) de segundo plano em modo de eficiência. Tudo volta ao sair do jogo.`).catch(() => {});
    }
  }
}

function resetLive() {
  Object.assign(live, { running: false, inGame: false, game: '', priority: 'none', throttled: 0, ticks: 0 });
}

// start() tem um await antes do spawn. Sem esta guarda, desligar o modo nesse
// intervalo encontrava `child` vazio, retornava na hora, e o spawn acontecia
// logo depois — deixando um auxiliar rodando com o modo desligado.
let starting = null;

function start() {
  if (process.platform !== 'win32' || child || stopping) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    await writeRuntimeFiles();
    if (!live.enabled || child || stopping) return;
    spawnHelper();
  })().finally(() => { starting = null; });
  return starting;
}

function spawnHelper() {
  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', files.helper(),
    '-EnginePath', files.engine(), '-ConfigPath', files.config(), '-RecoveryPath', files.recovery(), '-ParentPid', String(process.pid)
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child = proc;
  buffer = '';
  live.running = true;
  live.error = null;
  live.ticks = 0;
  // Conta a partir do spawn: compilar o C# leva ~1 s, bem abaixo do limite.
  live.lastTickAt = Date.now();

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line.startsWith('{')) continue;
      try { handleMessage(JSON.parse(line)); } catch { /* linha que não é nossa */ }
    }
  });
  proc.stderr.on('data', () => {});
  proc.stdin.on('error', () => {});
  proc.on('exit', () => {
    if (child !== proc) return;
    child = null;
    resetLive();
    if (stopping || !live.enabled) return;
    // Caiu sozinho com o modo ligado: tenta de novo, com limite.
    const now = Date.now();
    restarts = restarts.filter(at => now - at < RESTART_WINDOW_MS);
    if (restarts.length >= MAX_RESTARTS) {
      live.error = 'O modo durante o jogo parou várias vezes seguidas e foi pausado. Desligue e ligue de novo para tentar outra vez.';
      return;
    }
    restarts.push(now);
    setTimeout(() => { if (live.enabled && !child) start().catch(error => { live.error = error.message; }); }, 3000);
  });

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (child) writeConfig().catch(() => {}); }, GAMES_REFRESH_MS);
}

async function stop() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  // Um start() em andamento pode ainda criar o auxiliar: espera ele decidir.
  if (starting) await starting.catch(() => {});
  if (!child) return;
  if (stopping) return stopping;
  const proc = child;
  stopping = new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      // Não respondeu: encerra à força. O arquivo de recuperação cobre o resto
      // na próxima vez que o app abrir.
      try { proc.kill(); } catch {}
      resolve();
    }, STOP_TIMEOUT_MS);
    proc.once('exit', done);
    try { proc.stdin.write('stop\n'); } catch { try { proc.kill(); } catch {} }
  }).finally(() => {
    if (child === proc) child = null;
    stopping = null;
    resetLive();
  });
  return stopping;
}

// Sem o modo ligado, ainda pode haver sobra de uma sessão que caiu.
async function recoverLeftovers() {
  try { await fs.access(files.recovery()); } catch { return; }
  await writeRuntimeFiles();
  const script = `Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:AMARAL_ENGINE)); [AmaralGameSession]::Recover($env:AMARAL_RECOVERY)`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 30000, env: { ...process.env, AMARAL_ENGINE: files.engine(), AMARAL_RECOVERY: files.recovery() }
  });
  const restored = Number(stdout.trim()) || 0;
  if (restored > 0) await recordHistory('Modo durante o jogo: sessão interrompida restaurada', true, `${restored} alteração(ões) de uma sessão que não terminou direito foram desfeitas.`);
}

async function init(options = {}) {
  if (typeof options.recordHistory === 'function') recordHistory = options.recordHistory;
  if (process.platform !== 'win32') return;
  live.enabled = (await readState()).enabled;
  if (live.enabled) await start();
  else await recoverLeftovers().catch(() => {});
}

async function setEnabled(enabled) {
  if (process.platform !== 'win32') return { ok: false, message: 'Este recurso está disponível somente no Windows.' };
  if (typeof enabled !== 'boolean') return { ok: false, message: 'Valor inválido.' };
  const was = live.enabled;
  live.enabled = enabled;
  await writeState({ enabled });
  if (enabled) {
    restarts = [];
    try {
      await start();
    } catch (error) {
      live.enabled = false;
      await writeState({ enabled: false });
      return { ok: false, message: `Não foi possível ligar o modo: ${error.message}` };
    }
    return { ok: true, unchanged: was, message: 'Modo durante o jogo ligado. Ele age sozinho quando um jogo da lista estiver em primeiro plano.' };
  }
  await stop();
  return { ok: true, unchanged: !was, message: 'Modo durante o jogo desligado. Tudo que ele tinha alterado foi devolvido.' };
}

function getStatus() {
  const stale = live.running && Date.now() - live.lastTickAt > TICK_STALE_MS;
  return { supported: process.platform === 'win32', ...live, lastTickAt: undefined, stale };
}

function isRunning() {
  return Boolean(child);
}

async function refreshGames() {
  if (child) await writeConfig().catch(() => {});
}

module.exports = { init, setEnabled, getStatus, stop, isRunning, refreshGames, BACKGROUND_APPS, CHROMIUM_BROWSERS };
