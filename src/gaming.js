/**
 * Amaral Boost — aba Jogos: diagnóstico de Isolamento de núcleo e placa de
 * vídeo preferida por jogo.
 *
 * Isolamento de núcleo (VBS / Integridade de Memória) é SOMENTE leitura: é um
 * recurso de segurança, e o app não mexe em segurança (ver README). A tela
 * explica o custo em jogos e abre a página do Windows onde a própria pessoa
 * decide.
 *
 * Placa de vídeo por jogo usa a mesma chave que Configurações > Sistema > Tela
 * > Elementos gráficos grava: um valor por executável em
 * HKCU\Software\Microsoft\DirectX\UserGpuPreferences. O conteúdo é uma lista
 * "Chave=Valor;" que o Windows também usa para outras coisas (ex.: AppStatus),
 * então só o trecho GpuPreference é tocado, e o que havia nele antes fica
 * guardado para restaurar exatamente.
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const GPU_PREFS_SUBKEY = 'Software\\Microsoft\\DirectX\\UserGpuPreferences';
const GPU_HIGH_PERFORMANCE = '2';

// Os dados vão por variável de ambiente em JSON, nunca interpolados no script:
// caminho de jogo tem apóstrofo, colchete e acento, e nenhum escape manual
// cobre tudo isso com segurança.
async function runPS(script, data = null, timeout = 15000) {
  const safeScript = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ' + script;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', safeScript], {
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, AMARAL_ARGS: JSON.stringify(data ?? {}) }
  });
  return stdout.trim();
}

function parseJsonArray(text) {
  const parsed = JSON.parse(text || '[]');
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

// ---------- Isolamento de núcleo ----------

// Códigos de Win32_DeviceGuard.SecurityServicesRunning/Configured.
const SECURITY_SERVICE = { CREDENTIAL_GUARD: 1, HVCI: 2 };

async function getCoreIsolationStatus() {
  if (process.platform !== 'win32') return { supported: false };
  const script = `
    $dg = Get-CimInstance -Namespace root\\Microsoft\\Windows\\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $hvci = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Name Enabled -ErrorAction SilentlyContinue
    [pscustomobject]@{
      available = $null -ne $dg
      configured = @($dg.SecurityServicesConfigured | Where-Object { $null -ne $_ })
      running = @($dg.SecurityServicesRunning | Where-Object { $null -ne $_ })
      vbsStatus = if ($dg) { [int]$dg.VirtualizationBasedSecurityStatus } else { 0 }
      hypervisorPresent = [bool]$cs.HypervisorPresent
      hvciSetting = if ($null -eq $hvci) { $null } else { [int]$hvci.Enabled }
    } | ConvertTo-Json -Compress
  `;
  const raw = JSON.parse(await runPS(script));
  const running = (raw.running || []).map(Number);
  const hvciRunning = running.includes(SECURITY_SERVICE.HVCI);
  return {
    supported: true,
    available: Boolean(raw.available),
    // 0 = desligado, 1 = habilitado mas não rodando, 2 = rodando
    vbsStatus: Number(raw.vbsStatus) || 0,
    hvciRunning,
    // Integridade de Memória desligada em Configurações, mas ainda ativa até reiniciar.
    hvciPendingReboot: hvciRunning && raw.hvciSetting === 0,
    credentialGuardRunning: running.includes(SECURITY_SERVICE.CREDENTIAL_GUARD),
    hypervisorPresent: Boolean(raw.hypervisorPresent)
  };
}

// ---------- estado local das preferências de GPU ----------

function getStatePath() {
  return path.join(app.getPath('userData'), 'amaral-boost-gpu-preferences-state.json');
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(getStatePath(), 'utf8'));
    return {
      applied: parsed && typeof parsed.applied === 'object' && parsed.applied ? parsed.applied : {},
      manual: Array.isArray(parsed?.manual) ? parsed.manual.filter(item => typeof item === 'string') : []
    };
  } catch {
    return { applied: {}, manual: [] };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(getStatePath()), { recursive: true });
  await fs.writeFile(getStatePath(), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

const exeKey = exePath => path.normalize(exePath).toLowerCase();

// ---------- registro: UserGpuPreferences ----------

// Microsoft.Win32.Registry direto, e não os cmdlets *-ItemProperty: -Name
// desses cmdlets aceita curinga, e um caminho com [colchetes] seria tratado
// como padrão em vez de nome literal.
async function readGpuPreferences() {
  const script = `
    $rk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${GPU_PREFS_SUBKEY}')
    $out = @()
    if ($rk) { foreach ($n in $rk.GetValueNames()) { $out += [pscustomobject]@{ name = $n; value = [string]$rk.GetValue($n) } }; $rk.Close() }
    ConvertTo-Json -InputObject @($out) -Compress
  `;
  return parseJsonArray(await runPS(script)).filter(item => typeof item?.name === 'string');
}

// value === null apaga o valor inteiro.
async function writeGpuPreferenceValue(name, value) {
  const script = `
    $d = $env:AMARAL_ARGS | ConvertFrom-Json
    $rk = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${GPU_PREFS_SUBKEY}')
    if ($null -eq $d.value) { $rk.DeleteValue($d.name, $false) } else { $rk.SetValue($d.name, [string]$d.value, [Microsoft.Win32.RegistryValueKind]::String) }
    $rk.Close()
    Write-Output 'ok'
  `;
  const out = await runPS(script, { name, value });
  if (out !== 'ok') throw new Error('O Windows não confirmou a gravação da preferência.');
}

function parseTokens(value) {
  return String(value || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=');
    return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
  });
}

function readToken(value, key) {
  const found = parseTokens(value).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return found ? found[1] : null;
}

// Troca (ou remove, com tokenValue null) só um "Chave=Valor;", mantendo a
// ordem e todo o resto. Devolve null quando não sobra nada — aí o valor some.
function withToken(value, key, tokenValue) {
  const tokens = parseTokens(value);
  const at = tokens.findIndex(([name]) => name.toLowerCase() === key.toLowerCase());
  if (tokenValue === null) { if (at >= 0) tokens.splice(at, 1); }
  else if (at >= 0) tokens[at] = [tokens[at][0], String(tokenValue)];
  else tokens.push([key, String(tokenValue)]);
  return tokens.length ? tokens.map(([name, val]) => `${name}=${val};`).join('') : null;
}

function describePreference(token) {
  if (token === '2') return 'high';
  if (token === '1') return 'saving';
  if (token === '0') return 'auto';
  return null;
}

// ---------- detecção de jogos ----------

// O executável que a loja informa costuma ser um lançador (PlayRDR2.exe,
// start_protected_game.exe do anti-cheat, Sifu.exe da Unreal) — e a preferência
// de GPU só vale para o processo que realmente desenha a imagem. Então a
// escolha é: o maior .exe da pasta de instalação que não seja claramente
// instalador, anti-cheat, relatório de erro ou lançador. É heurística: o
// caminho escolhido aparece na tela e a pessoa pode adicionar outro à mão.
const SKIP_DIRS = /^(_commonredist|redist|redistributables?|directx|dotnet|vcredist|easyanticheat|battleye|eac|__installer|installer|support|prereqs?|engine|crashreport(er|client)?|\$pluginsdir)$/i;
const SKIP_EXES = /(unins|uninstall|setup|install|redist|vc_?redist|dxsetup|dxwebsetup|crash|report|launcher|bootstrap|start_protected_game|easyanticheat|battleye|be_service|prereq|dotnetfx|ndp\d|helper|updater|update|cefprocess|webhelper|overlay|notification|benchmark|config|settings|touchup|cleanup|dxdiag|quicksfv)/i;
const MAX_DEPTH = 5;

async function findMainExecutable(installDir) {
  let best = null;
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.test(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && /\.exe$/i.test(entry.name) && !SKIP_EXES.test(entry.name)) {
        try {
          const { size } = await fs.stat(full);
          if (!best || size > best.size) best = { path: full, size };
        } catch { /* arquivo sumiu no meio da leitura */ }
      }
    }
  }
  await walk(installDir, 0);
  return best?.path || null;
}

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function unescapeVdf(text) {
  return text.replace(/\\\\/g, '\\');
}

async function detectSteamGames() {
  const script = `$p = Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -Name SteamPath -ErrorAction SilentlyContinue; if ($p) { Write-Output $p.SteamPath }`;
  const steamPath = await runPS(script).catch(() => '');
  if (!steamPath) return [];
  const libraries = new Set([path.normalize(steamPath)]);
  try {
    const vdf = await fs.readFile(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(path.normalize(unescapeVdf(match[1])));
  } catch { /* só a biblioteca padrão */ }

  const games = [];
  const seenLibraries = new Set();
  for (const library of libraries) {
    if (seenLibraries.has(library.toLowerCase())) continue;
    seenLibraries.add(library.toLowerCase());
    const steamapps = path.join(library, 'steamapps');
    let files;
    try { files = await fs.readdir(steamapps); } catch { continue; }
    for (const file of files.filter(name => /^appmanifest_\d+\.acf$/i.test(name))) {
      try {
        const acf = await fs.readFile(path.join(steamapps, file), 'utf8');
        const name = acf.match(/"name"\s+"([^"]+)"/)?.[1];
        const installdir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1];
        const appid = acf.match(/"appid"\s+"(\d+)"/)?.[1];
        // 228980 = Steamworks Common Redistributables; não é jogo.
        if (!name || !installdir || appid === '228980' || /redistributable|steamvr|proton/i.test(name)) continue;
        games.push({ name: unescapeVdf(name), installDir: path.join(steamapps, 'common', unescapeVdf(installdir)), source: 'Steam' });
      } catch { /* manifesto ilegível: ignora só ele */ }
    }
  }
  return games;
}

async function detectEpicGames() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files;
  try { files = await fs.readdir(dir); } catch { return []; }
  const games = [];
  const seen = new Set();
  for (const file of files.filter(name => /\.item$/i.test(name))) {
    try {
      const item = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      // Sem LaunchExecutable = DLC/complemento que divide a pasta do jogo base.
      if (!item.InstallLocation || !item.LaunchExecutable || item.bIsIncompleteInstall) continue;
      const key = path.normalize(item.InstallLocation).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      games.push({ name: item.DisplayName || path.basename(item.InstallLocation), installDir: path.normalize(item.InstallLocation), source: 'Epic Games' });
    } catch { /* manifesto ilegível: ignora só ele */ }
  }
  return games;
}

function nameFromExe(exePath) {
  return path.basename(exePath).replace(/\.exe$/i, '').replace(/[-_](win64|win32|shipping|x64|dx1[12])/gi, '').trim() || path.basename(exePath);
}

async function hasHybridGraphics() {
  const script = `ConvertTo-Json -InputObject @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Name }) -Compress`;
  const names = parseJsonArray(await runPS(script).catch(() => '[]'))
    .filter(name => typeof name === 'string' && !/basic display|basic render|remote|virtual|parsec|mirror|indirect/i.test(name));
  return { gpus: names, hybrid: names.length >= 2 };
}

async function listGames() {
  if (process.platform !== 'win32') return { supported: false, games: [] };
  const [state, prefs, steam, epic, graphics] = await Promise.all([
    readState(), readGpuPreferences().catch(() => []), detectSteamGames().catch(() => []), detectEpicGames().catch(() => []), hasHybridGraphics()
  ]);
  const prefByKey = new Map(prefs.filter(item => /\.exe$/i.test(item.name)).map(item => [exeKey(item.name), item]));
  const games = new Map();

  // installDir só existe para jogos de loja (Steam/Epic). O Modo durante o jogo
  // reconhece esses pela pasta — assim funciona mesmo se a heurística escolheu o
  // .exe errado; jogos manuais ou vindos do registro são reconhecidos pelo .exe.
  function add(exePath, name, source, installDir = null) {
    const key = exeKey(exePath);
    if (games.has(key)) return;
    const pref = prefByKey.get(key);
    games.set(key, {
      id: key,
      name,
      exePath: pref?.name || exePath,
      installDir,
      source,
      preference: describePreference(readToken(pref?.value, 'GpuPreference')),
      managed: Boolean(state.applied[key]),
      manual: state.manual.some(item => exeKey(item) === key)
    });
  }

  for (const game of [...steam, ...epic]) {
    if (!(await pathExists(game.installDir))) continue;
    const prefix = game.installDir.toLowerCase().replace(/[\\/]+$/, '') + path.sep;
    // Se a pessoa (ou o Windows) já escolheu um executável dentro da pasta do
    // jogo, ele vale mais que a heurística.
    const chosen = [...prefByKey.keys()].find(key => key.startsWith(prefix));
    const exePath = chosen ? prefByKey.get(chosen).name : await findMainExecutable(game.installDir);
    if (exePath) add(exePath, game.name, game.source, game.installDir);
  }
  for (const exePath of state.manual) add(exePath, nameFromExe(exePath), 'Adicionado por você');
  for (const pref of prefByKey.values()) add(pref.name, nameFromExe(pref.name), 'Configurado no Windows');

  const list = [...games.values()];
  for (const game of list) game.exists = await pathExists(game.exePath);
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { supported: true, hybrid: graphics.hybrid, gpus: graphics.gpus, games: list };
}

// ---------- aplicar / desfazer ----------

function validExePath(exePath) {
  return typeof exePath === 'string' && exePath.length < 1024 && path.isAbsolute(exePath) && /\.exe$/i.test(exePath);
}

async function findPref(exePath) {
  const prefs = await readGpuPreferences();
  return prefs.find(item => exeKey(item.name) === exeKey(exePath)) || null;
}

async function setHighPerformance(exePath, enabled) {
  if (process.platform !== 'win32') return { ok: false, message: 'Este recurso está disponível somente no Windows.' };
  if (!validExePath(exePath) || typeof enabled !== 'boolean') return { ok: false, message: 'Executável inválido.' };
  const key = exeKey(exePath);
  const state = await readState();
  const pref = await findPref(exePath);
  // Registro não diferencia maiúsculas no nome do valor: reusa o nome existente.
  const valueName = pref?.name || exePath;
  const currentToken = readToken(pref?.value, 'GpuPreference');

  if (enabled) {
    if (!(await pathExists(exePath))) return { ok: false, message: 'Esse executável não existe mais nesse caminho.' };
    if (currentToken === GPU_HIGH_PERFORMANCE) return { ok: true, unchanged: true, message: 'Esse jogo já usa a placa de alto desempenho.' };
    const next = withToken(pref?.value, 'GpuPreference', GPU_HIGH_PERFORMANCE);
    await writeGpuPreferenceValue(valueName, next);
    if (!state.applied[key]) state.applied[key] = { exePath: valueName, prevToken: currentToken, appliedAt: new Date().toISOString() };
    await writeState(state);
    return { ok: true, message: 'Placa de alto desempenho definida. Vale a partir da próxima vez que o jogo abrir.' };
  }

  // Desfazer: se foi o Amaral Boost que mudou, volta exatamente ao trecho
  // GpuPreference de antes; se não foi, devolve a decisão ao Windows.
  const entry = state.applied[key];
  const restoreToken = entry ? entry.prevToken ?? null : null;
  if (currentToken === restoreToken) {
    if (entry) { delete state.applied[key]; await writeState(state); }
    return { ok: true, unchanged: true, message: 'Esse jogo já estava sem preferência forçada.' };
  }
  await writeGpuPreferenceValue(valueName, withToken(pref?.value, 'GpuPreference', restoreToken));
  if (entry) { delete state.applied[key]; await writeState(state); }
  return {
    ok: true,
    message: entry
      ? 'Preferência de placa de vídeo restaurada para o que era antes.'
      : 'Preferência removida: o Windows volta a escolher a placa de vídeo sozinho.'
  };
}

// Usado pelo Padrão Windows: desfaz só o que o Amaral Boost mudou.
async function revertAll() {
  if (process.platform !== 'win32') return [];
  const state = await readState();
  const results = [];
  for (const entry of Object.values(state.applied)) {
    const result = await setHighPerformance(entry.exePath, false).catch(error => ({ ok: false, message: error?.message || 'Falhou.' }));
    results.push({ setting: `Placa de vídeo: ${nameFromExe(entry.exePath)}`, status: result.ok ? (result.unchanged ? 'unchanged' : 'success') : 'failed', message: result.message });
  }
  return results;
}

async function addManualGame(exePath) {
  if (!validExePath(exePath) || !(await pathExists(exePath))) return { ok: false, message: 'Escolha um arquivo .exe que exista.' };
  const state = await readState();
  if (state.manual.some(item => exeKey(item) === exeKey(exePath))) return { ok: true, unchanged: true, message: 'Esse jogo já está na lista.' };
  state.manual.push(exePath);
  await writeState(state);
  return { ok: true, message: `${nameFromExe(exePath)} adicionado à lista.` };
}

async function removeManualGame(exePath) {
  if (!validExePath(exePath)) return { ok: false, message: 'Executável inválido.' };
  const state = await readState();
  const before = state.manual.length;
  state.manual = state.manual.filter(item => exeKey(item) !== exeKey(exePath));
  if (state.manual.length === before) return { ok: true, unchanged: true, message: 'Esse jogo não estava na lista manual.' };
  await writeState(state);
  return { ok: true, message: 'Removido da lista. A preferência de placa de vídeo, se houver, continua como está.' };
}

module.exports = {
  getCoreIsolationStatus, listGames, setHighPerformance, revertAll, addManualGame, removeManualGame, nameFromExe,
  // expostos para teste
  _internal: { withToken, readToken, findMainExecutable }
};
