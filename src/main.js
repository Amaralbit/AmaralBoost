const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const fs = require('node:fs/promises');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { TWEAKS, CLEANUPS, GAMER_BUNDLE, BATTERY_BUNDLE } = require('./tweaks');
const ramLimit = require('./ram-limit');

const execFileAsync = promisify(execFile);
const REG_ABSENT = '__AMARAL_ABSENT__';
const BALANCED_PLAN_GUID = '381b4222-f694-41f0-9685-ff5bb260df2e';
const HIGH_PERFORMANCE_PLAN_GUID = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const POWER_SAVER_PLAN_GUID = 'a1841308-3541-4fab-bc81-f71556f20b4a';
// GUID do overlay "Economia de energia" do Modo de Energia do Windows 11 (o
// seletor de Configurações > Energia e bateria, separado do plano de energia
// clássico acima). Usado só para aplicar o ajuste 'battery-power-mode-eco' na
// hora, sem esperar a próxima desconexão da tomada — ver applyBatteryOverlayNow.
const OVERLAY_BETTER_BATTERY_GUID = '961cc777-2547-4f9d-8174-7d86181b8a7a';
// Mesmo overlay, lado oposto: usado pelo perfil Gamer para forçar Desempenho
// Máximo enquanto o notebook está na tomada (ver applyGamerOverlayNow).
const OVERLAY_MAX_PERFORMANCE_GUID = 'ded574b5-45a0-4f42-8737-46345c09c238';
const PROFILE_NAMES = ['Equilibrado', 'Gamer', 'Economia de Bateria', 'Padrão Windows'];
const PROFILE_POWER_PLANS = {
  Equilibrado: { guid: BALANCED_PLAN_GUID, label: 'Equilibrado' },
  Gamer: { guid: HIGH_PERFORMANCE_PLAN_GUID, label: 'Alto desempenho' },
  'Economia de Bateria': { guid: POWER_SAVER_PLAN_GUID, label: 'Economia de energia' }
};
const GAME_MODE_PATH = 'HKCU:\\Software\\Microsoft\\GameBar';
const GAME_MODE_VALUE = 'AutoGameModeEnabled';
const MAX_HISTORY_ENTRIES = 200;
const GITHUB_REPO = 'Amaralbit/AmaralBoost';
let tray = null;
let mainWindow = null;
let isQuitting = false;
let isClosePromptOpen = false;

// O Amaral Boost sempre abre elevado (Administrador): a maioria dos ajustes
// mexe em chaves de registro e serviços que exigem privilégio, e alternar
// entre elevado/não-elevado no meio do uso gerava a mensagem "abra como
// administrador" no pior momento. O instalador NSIS já marca o executável com
// requestedExecutionLevel=requireAdministrator (ver package.json → build.win),
// então numa instalação normal o próprio Windows pede o UAC antes do processo
// sequer iniciar. Este bloco é a rede de segurança para quando o app roda sem
// esse manifesto (ex.: `npm start` em desenvolvimento): se o processo já não
// estiver elevado, ele relança a si mesmo com o verbo "runas" e encerra a
// cópia sem privilégio. Se o usuário cancelar o UAC, o app simplesmente não
// abre — mesmo comportamento de qualquer ferramenta que exige administrador.
const ELEVATION_FLAG = '--amaral-boost-elevated';

function isProcessElevated() {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], { windowsHide: true, timeout: 8000 }).toString().trim().toLowerCase();
    return output === 'true';
  } catch {
    return false;
  }
}

function relaunchElevatedAndExit() {
  const exePath = process.execPath;
  const args = [...process.argv.slice(1), ELEVATION_FLAG];
  const quotedArgs = args.map(arg => `'${String(arg).replace(/'/g, "''")}'`).join(',');
  const command = [
    `Start-Process -FilePath '${exePath.replace(/'/g, "''")}'`,
    `-WorkingDirectory '${process.cwd().replace(/'/g, "''")}'`,
    args.length ? `-ArgumentList ${quotedArgs}` : '',
    '-Verb RunAs'
  ].filter(Boolean).join(' ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 });
  } catch {
    // Usuário cancelou o UAC (ou o relançamento falhou): encerra sem abrir sem privilégio.
  }
  app.exit(0);
}

if (process.platform === 'win32' && !process.argv.includes(ELEVATION_FLAG) && !isProcessElevated()) {
  relaunchElevatedAndExit();
  return;
}

// Sem isso, cada clique no atalho (com o app já aberto ou em segundo plano na
// bandeja) abria um processo novo e independente — dois estados diferentes,
// um perfil aplicado em cada janela. Só a primeira instância continua; as
// seguintes só piscam a janela já aberta e encerram.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => showMainWindow());

function formatGiB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

function safeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readWindowsDetails() {
  if (process.platform !== 'win32') return {};
  const script = [
    "$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Name",
    "$gpu = Get-CimInstance -ClassName Win32_VideoController | Select-Object -First 1 -ExpandProperty Name",
    "$windows = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object -First 1 Caption, Version, BuildNumber",
    "[pscustomobject]@{ cpu = $cpu; gpu = $gpu; windowsName = $windows.Caption; windowsVersion = $windows.Version; windowsBuild = $windows.BuildNumber } | ConvertTo-Json -Compress"
  ].join('; ');

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim());
  } catch {
    return {};
  }
}

async function getSystemInfo() {
  const windows = await readWindowsDetails();
  return {
    cpu: safeText(windows.cpu) || safeText(os.cpus()?.[0]?.model),
    gpu: safeText(windows.gpu),
    memoryTotal: formatGiB(os.totalmem()),
    memoryAvailable: formatGiB(os.freemem()),
    windows: safeText(windows.windowsName),
    windowsVersion: safeText(windows.windowsVersion),
    windowsBuild: safeText(windows.windowsBuild),
    source: 'Leitura local e somente leitura'
  };
}

async function runWindows(command, args) {
  if (process.platform !== 'win32') throw new Error('Este recurso está disponível somente no Windows.');
  return execFileAsync(command, args, { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
}

// ---------- tela Desempenho: leitura local ao vivo ----------
// Specs (modelo, núcleos, tipo/velocidade de RAM, disco, adaptador de rede) mudam
// raramente durante uma sessão, então são lidas uma vez e guardadas em memória.
// Métricas "ao vivo" (uso de CPU/memória/GPU/disco/rede) são lidas a cada chamada,
// sem guardar histórico no processo principal — quem mantém o histórico pro
// gráfico é a tela, que só busca uma leitura nova a cada poucos segundos.

const MEMORY_TYPE_LABELS = { 20: 'DDR', 21: 'DDR2', 22: 'DDR2 FB-DIMM', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' };
let performanceSpecsCache = null;

function clampPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

function toGiB(bytes, decimals = 1) {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? +(bytes / 1024 ** 3).toFixed(decimals) : null;
}

function toMBps(bytesPerSec) {
  return typeof bytesPerSec === 'number' && Number.isFinite(bytesPerSec) && bytesPerSec >= 0 ? +(bytesPerSec / 1e6).toFixed(1) : null;
}

function cpuTimesSnapshot() {
  return os.cpus().reduce((acc, cpu) => {
    acc.idle += cpu.times.idle;
    acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

// Uso de CPU não vem de um único valor do SO: é a diferença entre dois
// instantâneos dos contadores acumulados de cada núcleo, com uma pequena
// espera entre eles — a mesma técnica que qualquer monitor de sistema usa.
async function readCpuPercent() {
  const start = cpuTimesSnapshot();
  await new Promise(resolve => setTimeout(resolve, 200));
  const end = cpuTimesSnapshot();
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  return totalDelta > 0 ? clampPercent((1 - idleDelta / totalDelta) * 100) : null;
}

async function readGpuDiskNetworkLive() {
  // Usa classes WMI Win32_PerfFormattedData_* em vez de Get-Counter: os nomes de
  // categoria/contador do Get-Counter são traduzidos em Windows não-inglês (ex.:
  // "\PhysicalDisk" não existe em pt-BR e a chamada falha em silêncio), enquanto
  // as classes WMI têm nome fixo em qualquer idioma do Windows.
  const script = `
    function Sum-Property($items, [string]$prop) {
      if (-not $items) { return $null }
      ($items | Measure-Object -Property $prop -Sum).Sum
    }
    $gpuEngines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
    $gpuPercent = $null
    if ($gpuEngines) {
      $grouped = $gpuEngines | ForEach-Object {
        $key = if ($_.Name -match '^pid_\\d+_(.+)$') { $Matches[1] } else { $_.Name }
        [pscustomobject]@{ Key = $key; Value = $_.UtilizationPercentage }
      } | Group-Object Key | ForEach-Object { ($_.Group | Measure-Object -Property Value -Sum).Sum }
      if ($grouped) { $gpuPercent = ($grouped | Measure-Object -Maximum).Maximum }
    }
    $vramItems = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue
    $vramBytes = Sum-Property $vramItems 'DedicatedUsage'
    $diskItem = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
    $diskPercent = if ($diskItem) { $diskItem.PercentDiskTime } else { $null }
    $netItems = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue
    $netDownBytes = Sum-Property $netItems 'BytesReceivedPersec'
    $netUpBytes = Sum-Property $netItems 'BytesSentPersec'
    [pscustomobject]@{ gpuPercent = $gpuPercent; vramBytes = $vramBytes; diskPercent = $diskPercent; netDownBytesPerSec = $netDownBytes; netUpBytesPerSec = $netUpBytes } | ConvertTo-Json -Compress
  `;
  try {
    const stdout = await runPowerShellScript(script, 8000);
    const parsed = JSON.parse(stdout || '{}');
    return {
      gpuPercent: clampPercent(parsed.gpuPercent),
      vramGB: toGiB(parsed.vramBytes),
      diskPercent: clampPercent(parsed.diskPercent),
      netDownMBs: toMBps(parsed.netDownBytesPerSec),
      netUpMBs: toMBps(parsed.netUpBytesPerSec)
    };
  } catch {
    return { gpuPercent: null, vramGB: null, diskPercent: null, netDownMBs: null, netUpMBs: null };
  }
}

async function getPerformanceLive() {
  const [cpuPercent, gpuDiskNetwork] = await Promise.all([readCpuPercent(), readGpuDiskNetworkLive()]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const speedMHz = os.cpus()?.[0]?.speed;
  return {
    cpuPercent,
    cpuGHz: Number.isFinite(speedMHz) && speedMHz > 0 ? +(speedMHz / 1000).toFixed(2) : null,
    memUsedGB: toGiB(usedMem),
    memTotalGB: toGiB(totalMem),
    memPercent: totalMem > 0 ? clampPercent((usedMem / totalMem) * 100) : null,
    ...gpuDiskNetwork
  };
}

async function readPerformanceSpecs() {
  if (performanceSpecsCache) return performanceSpecsCache;
  if (process.platform !== 'win32') return (performanceSpecsCache = {});
  const script = `
    $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    $mem = Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue
    $memArray = Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue | Select-Object -First 1
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name
    $physicalDisk = $null
    try { $physicalDisk = Get-PhysicalDisk -ErrorAction Stop | Select-Object -First 1 FriendlyName, MediaType, BusType } catch {}
    $diskModel = Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Model
    $netAdapter = Get-CimInstance Win32_NetworkAdapter -Filter "NetConnectionStatus=2" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name
    [pscustomobject]@{
      cpuName = $cpu.Name
      cpuCores = $cpu.NumberOfCores
      cpuThreads = $cpu.NumberOfLogicalProcessors
      memSpeed = ($mem | Select-Object -First 1 -ExpandProperty Speed -ErrorAction SilentlyContinue)
      memType = ($mem | Select-Object -First 1 -ExpandProperty SMBIOSMemoryType -ErrorAction SilentlyContinue)
      memSlotsUsed = ($mem | Measure-Object).Count
      memSlotsTotal = $memArray.MemoryDevices
      gpuName = $gpu
      diskFriendlyName = $physicalDisk.FriendlyName
      diskMediaType = $physicalDisk.MediaType
      diskBusType = $physicalDisk.BusType
      diskModel = $diskModel
      netAdapterName = $netAdapter
    } | ConvertTo-Json -Compress
  `;
  try {
    const stdout = await runPowerShellScript(script, 10000);
    const parsed = JSON.parse(stdout || '{}');
    performanceSpecsCache = {
      cpuModel: safeText(parsed.cpuName) || safeText(os.cpus()?.[0]?.model),
      cpuCores: Number.isFinite(parsed.cpuCores) ? parsed.cpuCores : null,
      cpuThreads: Number.isFinite(parsed.cpuThreads) ? parsed.cpuThreads : (os.cpus()?.length || null),
      memType: MEMORY_TYPE_LABELS[parsed.memType] || null,
      memSpeed: Number.isFinite(parsed.memSpeed) ? parsed.memSpeed : null,
      memSlotsUsed: Number.isFinite(parsed.memSlotsUsed) ? parsed.memSlotsUsed : null,
      memSlotsTotal: Number.isFinite(parsed.memSlotsTotal) ? parsed.memSlotsTotal : null,
      gpuName: safeText(parsed.gpuName),
      diskLabel: safeText(parsed.diskFriendlyName) || safeText(parsed.diskModel),
      diskMediaType: safeText(parsed.diskMediaType),
      diskBusType: safeText(parsed.diskBusType) && safeText(parsed.diskBusType) !== safeText(parsed.diskMediaType) ? safeText(parsed.diskBusType) : null,
      netAdapterName: safeText(parsed.netAdapterName)
    };
  } catch {
    performanceSpecsCache = {};
  }
  return performanceSpecsCache;
}

function getSnapshotPath() {
  return path.join(app.getPath('userData'), 'amaral-boost-profile-snapshot.json');
}

async function readSnapshot() {
  try {
    return JSON.parse(await fs.readFile(getSnapshotPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Não foi possível ler o snapshot de restauração.');
  }
}

async function writeSnapshot(snapshot) {
  await fs.mkdir(path.dirname(getSnapshotPath()), { recursive: true });
  await fs.writeFile(getSnapshotPath(), JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function getHistoryPath() {
  return path.join(app.getPath('userData'), 'amaral-boost-history.json');
}

async function readHistory() {
  try {
    const parsed = JSON.parse(await fs.readFile(getHistoryPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return [];
  }
}

async function writeHistoryFile(history) {
  await fs.mkdir(path.dirname(getHistoryPath()), { recursive: true });
  await fs.writeFile(getHistoryPath(), JSON.stringify(history, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function appendHistoryEntry(entry) {
  const history = await readHistory();
  history.unshift(entry);
  const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);
  await writeHistoryFile(trimmed);
  return trimmed;
}

// ---------- motor genérico de ajustes individuais (registro) ----------
// Lê o valor atual de cada chave ANTES de escrever, guarda como backup em
// amaral-boost-tweaks-state.json e usa exatamente esse valor para reverter.
// Nunca assume um "padrão do Windows": ou tem backup, ou não reverte nada.

function getTweaksStatePath() {
  return path.join(app.getPath('userData'), 'amaral-boost-tweaks-state.json');
}

async function readTweaksState() {
  try {
    const parsed = JSON.parse(await fs.readFile(getTweaksStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.applied ? parsed : { applied: {} };
  } catch {
    return { applied: {} };
  }
}

async function writeTweaksState(state) {
  await fs.mkdir(path.dirname(getTweaksStatePath()), { recursive: true });
  await fs.writeFile(getTweaksStatePath(), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function regPsPath(hive, key) {
  return `${hive}:\\${key}`;
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function runPowerShellScript(script, timeout = 15000) {
  // Best-effort: ajuda quando o próprio PowerShell escreve texto acentuado.
  // Não resolve a saída de programas nativos (ex.: ipconfig), que escrevem no
  // codepage OEM do Windows por conta própria — por isso as mensagens exibidas
  // ao usuário nunca dependem do texto bruto desses programas (ver tweaks.js).
  const safeScript = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ' + script;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', safeScript], { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function regGet(hive, key, name) {
  const p = psQuote(regPsPath(hive, key));
  const n = psQuote(name);
  try {
    return await runPowerShellScript(`$v = Get-ItemProperty -Path '${p}' -Name '${n}' -ErrorAction SilentlyContinue; if ($null -eq $v) { Write-Output '${REG_ABSENT}' } else { Write-Output $v.'${n}' }`);
  } catch {
    return REG_ABSENT;
  }
}

async function regSet(hive, key, name, type, value) {
  const p = psQuote(regPsPath(hive, key));
  const n = psQuote(name);
  const v = type === 'String' ? `'${psQuote(value)}'` : String(Number(value) | 0);
  await runPowerShellScript(`if (-not (Test-Path '${p}')) { New-Item -Path '${p}' -Force | Out-Null }; Set-ItemProperty -Path '${p}' -Name '${n}' -Value ${v} -Type ${type} -ErrorAction Stop`);
}

async function regRemove(hive, key, name) {
  const p = psQuote(regPsPath(hive, key));
  const n = psQuote(name);
  await runPowerShellScript(`Remove-ItemProperty -Path '${p}' -Name '${n}' -ErrorAction SilentlyContinue`);
}

async function rollbackRegOps(backup) {
  for (const op of backup) {
    if (op.prev === REG_ABSENT) await regRemove(op.hive, op.key, op.name);
    else await regSet(op.hive, op.key, op.name, op.type, op.type === 'DWord' ? parseInt(op.prev, 10) : op.prev);
  }
}

async function isAdmin() {
  try {
    const out = await runPowerShellScript(`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`);
    return out.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function findTweak(id) {
  const tweak = TWEAKS.find(item => item.id === id);
  if (!tweak) throw new Error('Ajuste desconhecido.');
  return tweak;
}

function findCleanup(id) {
  const cleanup = CLEANUPS.find(item => item.id === id);
  if (!cleanup) throw new Error('Ação de limpeza desconhecida.');
  return cleanup;
}

async function applyTweak(tweak) {
  if (tweak.admin && !(await isAdmin())) {
    return { ok: false, message: 'Este ajuste exige abrir o Amaral Boost como administrador.' };
  }
  const state = await readTweaksState();
  if (state.applied[tweak.id]) return { ok: true, noop: true, message: 'Já estava aplicado.' };
  const backup = [];
  for (const op of tweak.regOps) backup.push({ ...op, prev: await regGet(op.hive, op.key, op.name) });
  try {
    for (const op of tweak.regOps) await regSet(op.hive, op.key, op.name, op.type, op.value);
  } catch {
    await rollbackRegOps(backup).catch(() => {});
    return { ok: false, message: 'Não foi possível aplicar o ajuste (nada ficou alterado).' };
  }
  state.applied[tweak.id] = { appliedAt: new Date().toISOString(), backup };
  await writeTweaksState(state);
  return { ok: true, message: 'Aplicado.' };
}

async function revertTweakById(tweak) {
  const state = await readTweaksState();
  const entry = state.applied[tweak.id];
  if (!entry) return { ok: true, noop: true, message: 'Nada para reverter.' };
  try {
    await rollbackRegOps(entry.backup);
  } catch {
    return { ok: false, message: 'Não foi possível restaurar. Tente novamente como administrador.' };
  }
  delete state.applied[tweak.id];
  await writeTweaksState(state);
  return { ok: true, message: 'Revertido para o estado original.' };
}

async function tweaksState() {
  const state = await readTweaksState();
  return {
    admin: await isAdmin(),
    applied: Object.fromEntries(Object.entries(state.applied).map(([id, entry]) => [id, { appliedAt: entry.appliedAt }]))
  };
}

async function tweaksCatalog() {
  return {
    tweaks: TWEAKS.map(({ id, name, desc, notWhen, tags, admin }) => ({ id, name, desc, notWhen: notWhen || null, tags, admin: !!admin })),
    cleanups: CLEANUPS.map(({ id, name, desc, tags }) => ({ id, name, desc, tags })),
    gamerBundle: GAMER_BUNDLE,
    batteryBundle: BATTERY_BUNDLE
  };
}

// aplica/roda um item do pacote do Gamer e devolve no formato {setting, status, message}
// usado na lista de resultados do perfil — sem gerar uma entrada de histórico própria,
// porque tudo isso faz parte de uma única aplicação do perfil Gamer.
async function applyTweakForResult(id) {
  let tweak;
  try { tweak = findTweak(id); } catch { return { setting: id, status: 'failed', message: 'Ajuste desconhecido.' }; }
  const result = await applyTweak(tweak);
  return { setting: tweak.name, status: result.ok ? (result.noop ? 'unchanged' : 'success') : 'failed', message: result.message };
}

async function runCleanupForResult(id) {
  let cleanup;
  try { cleanup = findCleanup(id); } catch { return { setting: id, status: 'failed', message: 'Limpeza desconhecida.' }; }
  try {
    await runPowerShellScript(cleanup.cmd, 60000);
    return { setting: cleanup.name, status: 'success', message: cleanup.successMessage || 'Executado.' };
  } catch {
    return { setting: cleanup.name, status: 'failed', message: 'Não foi possível executar esta limpeza.' };
  }
}

async function recordTweakHistory(kind, label, ok, noop, message) {
  const entry = {
    id: randomUUID(),
    kind,
    label,
    appliedAt: new Date().toISOString(),
    applied: ok,
    results: [{ setting: label, status: ok ? (noop ? 'unchanged' : 'success') : 'failed', message }]
  };
  await appendHistoryEntry(entry).catch(() => {});
  return entry;
}

async function applyTweakById(id) {
  const tweak = findTweak(id);
  const result = await applyTweak(tweak);
  const historyEntry = await recordTweakHistory('tweak', tweak.name, result.ok, result.noop, result.message);
  return { ...result, id, historyEntry };
}

async function revertTweakByIdHandler(id) {
  const tweak = findTweak(id);
  const result = await revertTweakById(tweak);
  const historyEntry = await recordTweakHistory('tweak', `Reverter: ${tweak.name}`, result.ok, result.noop, result.message);
  return { ...result, id, historyEntry };
}

async function enableRamLimit(limitMB) {
  const result = await ramLimit.enable(limitMB);
  const historyEntry = await recordTweakHistory('ram-limit', `Ativar limite de RAM para navegadores${result.limitMB ? ` (${(result.limitMB / 1024).toFixed(1)} GB)` : ''}`, result.ok, false, result.message);
  return { ...result, historyEntry, state: await ramLimit.getState().catch(() => null) };
}

async function disableRamLimit() {
  const result = await ramLimit.disable();
  const historyEntry = await recordTweakHistory('ram-limit', 'Desativar limite de RAM para navegadores', result.ok, false, result.message);
  return { ...result, historyEntry, state: await ramLimit.getState().catch(() => null) };
}

async function runCleanupById(id) {
  const cleanup = findCleanup(id);
  let result;
  try {
    await runPowerShellScript(cleanup.cmd, 60000);
    result = { ok: true, message: cleanup.successMessage || 'Executado.' };
  } catch {
    result = { ok: false, message: 'Não foi possível executar esta limpeza.' };
  }
  const historyEntry = await recordTweakHistory('cleanup', cleanup.name, result.ok, false, result.message);
  return { ...result, id, historyEntry };
}

// reverte todo ajuste individual que ainda esteja marcado como aplicado —
// usado pelo Padrão Windows, pra "restaurar tudo" ser uma promessa real.
async function revertAllTweaks() {
  const state = await readTweaksState();
  const ids = Object.keys(state.applied);
  const results = [];
  for (const id of ids) {
    let tweak;
    try { tweak = findTweak(id); } catch { continue; } // ajuste removido do catálogo: ignora, sem travar a restauração
    const result = await revertTweakById(tweak);
    results.push({ setting: `Ajuste: ${tweak.name}`, status: result.ok ? 'success' : 'failed', message: result.message });
  }
  return results;
}

function parsePlanGuid(output) {
  return output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase() || null;
}

async function readActivePowerPlan() {
  const { stdout } = await runWindows('powercfg.exe', ['/getactivescheme']);
  const guid = parsePlanGuid(stdout);
  if (!guid) throw new Error('O plano de energia ativo não pôde ser identificado.');
  return guid;
}

async function listPowerPlans() {
  const { stdout } = await runWindows('powercfg.exe', ['/list']);
  return [...stdout.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map(match => match[0].toLowerCase());
}

async function activatePowerPlan(guid, label) {
  const available = await listPowerPlans();
  if (!available.includes(guid)) return { setting: 'Plano de energia', status: 'failed', message: `${label} não está disponível neste computador.` };
  const current = await readActivePowerPlan();
  if (current === guid) return { setting: 'Plano de energia', status: 'unchanged', message: `${label} já está ativo.` };
  try {
    await runWindows('powercfg.exe', ['/setactive', guid]);
    const after = await readActivePowerPlan();
    return after === guid
      ? { setting: 'Plano de energia', status: 'success', message: `${label} foi ativado.` }
      : { setting: 'Plano de energia', status: 'failed', message: 'O Windows não confirmou a alteração do plano.' };
  } catch {
    return { setting: 'Plano de energia', status: 'failed', message: `Não foi possível ativar ${label}.` };
  }
}

// Os ajustes 'battery-power-mode-eco' e 'gamer-power-mode-max' só gravam a
// chave de registro que o Windows consulta na próxima troca de fonte de
// energia (plugar/desplugar). Se a pessoa já está na fonte certa no momento
// de aplicar o perfil, isso sozinho não muda nada na tela até trocar de
// fonte — então, além de gravar a chave, chamamos a mesma função que o app
// Configurações usa (PowerSetActiveOverlayScheme, de powrprof.dll) pra
// refletir a troca imediatamente quando fizer sentido.
async function readPowerSource() {
  const script = `
    $b = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $b) { Write-Output 'sem-bateria' } elseif ($b.PowerOnline) { Write-Output 'tomada' } else { Write-Output 'bateria' }
  `;
  try {
    return (await runPowerShellScript(script, 5000)).trim();
  } catch {
    return 'desconhecido';
  }
}

async function setActiveOverlaySchemeNow(guid) {
  const script = `
    Add-Type -Name Overlay -Namespace AmaralBoost -MemberDefinition '[DllImport("powrprof.dll")] public static extern uint PowerSetActiveOverlayScheme(Guid overlayGuid);'
    Write-Output ([AmaralBoost.Overlay]::PowerSetActiveOverlayScheme([Guid]'${guid}'))
  `;
  const out = await runPowerShellScript(script, 8000);
  return out.trim() === '0';
}

// `acceptedSources` é a lista de valores de readPowerSource() que contam como
// "aplicar agora". Um desktop sem bateria nunca reporta 'bateria', então o
// lado tomada aceita também 'sem-bateria' — nesses PCs a máquina está sempre,
// na prática, na fonte de energia.
async function applyOverlaySchemeIfOnSource(acceptedSources, guid, messages) {
  const source = await readPowerSource();
  if (!acceptedSources.includes(source)) {
    return { setting: 'Modo de Energia (Windows)', status: 'unchanged', message: messages.pending };
  }
  try {
    const confirmed = await setActiveOverlaySchemeNow(guid);
    return confirmed
      ? { setting: 'Modo de Energia (Windows)', status: 'success', message: messages.applied }
      : { setting: 'Modo de Energia (Windows)', status: 'failed', message: 'O Windows não confirmou a troca imediata do Modo de Energia.' };
  } catch {
    return { setting: 'Modo de Energia (Windows)', status: 'failed', message: 'Não foi possível trocar o Modo de Energia agora.' };
  }
}

function applyBatteryOverlayNow() {
  return applyOverlaySchemeIfOnSource(['bateria'], OVERLAY_BETTER_BATTERY_GUID, {
    applied: 'Trocado agora para Economia de energia, porque o notebook está na bateria.',
    pending: 'Definido para a próxima vez que o notebook estiver na bateria (agora está na tomada).'
  });
}

function applyGamerOverlayNow() {
  return applyOverlaySchemeIfOnSource(['tomada', 'sem-bateria'], OVERLAY_MAX_PERFORMANCE_GUID, {
    applied: 'Trocado agora para Desempenho Máximo.',
    pending: 'Definido para a próxima vez que estiver na tomada (agora está na bateria).'
  });
}

async function readGameMode() {
  const script = [
    `$item = Get-ItemProperty -Path '${GAME_MODE_PATH}' -ErrorAction SilentlyContinue`,
    `$property = if ($item) { $item.PSObject.Properties['${GAME_MODE_VALUE}'] }`,
    "$result = if ($null -eq $property) { [pscustomobject]@{ exists = $false; value = $null } } else { [pscustomobject]@{ exists = $true; value = [int]$property.Value } }",
    '$result | ConvertTo-Json -Compress'
  ].join('; ');
  const { stdout } = await runWindows('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return JSON.parse(stdout.trim());
}

async function writeGameMode(value) {
  const normalized = value === 1 ? 1 : 0;
  const script = `New-Item -Path '${GAME_MODE_PATH}' -Force | Out-Null; Set-ItemProperty -Path '${GAME_MODE_PATH}' -Name '${GAME_MODE_VALUE}' -Type DWord -Value ${normalized}`;
  await runWindows('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

async function removeGameModeValue() {
  const script = `Remove-ItemProperty -Path '${GAME_MODE_PATH}' -Name '${GAME_MODE_VALUE}' -ErrorAction SilentlyContinue`;
  await runWindows('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function gameModeDescription(state) {
  if (!state?.exists) return 'não definido pelo usuário';
  return state.value === 1 ? 'ativado' : 'desativado';
}

async function captureSnapshot() {
  const existing = await readSnapshot();
  if (existing) return existing;
  const [powerPlanGuid, gameMode] = await Promise.all([readActivePowerPlan(), readGameMode()]);
  const snapshot = { version: 1, capturedAt: new Date().toISOString(), powerPlanGuid, gameMode: { exists: Boolean(gameMode.exists), value: gameMode.exists ? Number(gameMode.value) : null } };
  await writeSnapshot(snapshot);
  return snapshot;
}

async function profileState() {
  const [snapshot, powerPlanGuid, gameMode] = await Promise.all([readSnapshot(), readActivePowerPlan(), readGameMode()]);
  return { snapshot: snapshot ? { powerPlanGuid: snapshot.powerPlanGuid, gameMode: snapshot.gameMode, capturedAt: snapshot.capturedAt } : null, current: { powerPlanGuid, gameMode } };
}

async function finalizeApplyResult(profile, results) {
  const applied = results.every(result => result.status !== 'failed');
  const entry = { id: randomUUID(), kind: 'profile', profile, label: profile, appliedAt: new Date().toISOString(), applied, results };
  await appendHistoryEntry(entry).catch(() => {});
  return { profile, applied, results, historyEntry: entry, state: await profileState().catch(() => null) };
}

async function applyProfile(profile) {
  if (!PROFILE_NAMES.includes(profile)) throw new Error('Perfil inválido.');
  if (profile === 'Padrão Windows') {
    const tweaksResults = await revertAllTweaks().catch(() => []);
    const snapshot = await readSnapshot();
    if (!snapshot) {
      const noSnapshot = { setting: 'Restauração', status: 'failed', message: 'Não há snapshot pré-Amaral. Nenhuma configuração de perfil foi alterada.' };
      return finalizeApplyResult(profile, [noSnapshot, ...tweaksResults]);
    }
    const power = await activatePowerPlan(snapshot.powerPlanGuid, 'o plano salvo antes do Amaral Boost');
    let gameMode;
    try {
      const current = await readGameMode();
      const matches = current.exists === snapshot.gameMode.exists && (!current.exists || current.value === snapshot.gameMode.value);
      if (matches) gameMode = { setting: 'Game Mode', status: 'unchanged', message: `Já está ${gameModeDescription(snapshot.gameMode)} como no snapshot.` };
      else { if (snapshot.gameMode.exists) await writeGameMode(snapshot.gameMode.value); else await removeGameModeValue(); gameMode = { setting: 'Game Mode', status: 'success', message: `Restaurado para ${gameModeDescription(snapshot.gameMode)} como no snapshot.` }; }
    } catch { gameMode = { setting: 'Game Mode', status: 'failed', message: 'Não foi possível restaurar o Game Mode.' }; }
    return finalizeApplyResult(profile, [power, gameMode, ...tweaksResults]);
  }

  let snapshot;
  try { snapshot = await captureSnapshot(); } catch { return finalizeApplyResult(profile, [{ setting: 'Snapshot de segurança', status: 'failed', message: 'Não foi possível salvar o estado original. Nenhuma configuração foi alterada.' }]); }
  const plan = PROFILE_POWER_PLANS[profile];
  const power = await activatePowerPlan(plan.guid, plan.label);
  let gameMode;
  if (profile === 'Equilibrado') {
    try {
      const current = await readGameMode();
      const matches = current.exists === snapshot.gameMode.exists && (!current.exists || current.value === snapshot.gameMode.value);
      if (matches) gameMode = { setting: 'Game Mode', status: 'unchanged', message: `Mantido em ${gameModeDescription(snapshot.gameMode)} como no estado original.` };
      else { if (snapshot.gameMode.exists) await writeGameMode(snapshot.gameMode.value); else await removeGameModeValue(); gameMode = { setting: 'Game Mode', status: 'success', message: `Restaurado para ${gameModeDescription(snapshot.gameMode)} como no estado original.` }; }
    } catch { gameMode = { setting: 'Game Mode', status: 'failed', message: 'Não foi possível restaurar o Game Mode ao estado original.' }; }
    return finalizeApplyResult(profile, [power, gameMode]);
  }

  if (profile === 'Economia de Bateria') {
    // Game Mode reserva GPU/CPU para o jogo em primeiro plano — sem relação com
    // economizar bateria, então este perfil desativa em vez de herdar o padrão.
    try { await writeGameMode(0); const current = await readGameMode(); gameMode = current.exists && current.value === 0 ? { setting: 'Game Mode', status: 'success', message: 'Desativado para o usuário atual.' } : { setting: 'Game Mode', status: 'failed', message: 'O Windows não confirmou a desativação.' }; } catch { gameMode = { setting: 'Game Mode', status: 'failed', message: 'Não foi possível desativar o Game Mode.' }; }
    const results = [power, gameMode];
    for (const id of BATTERY_BUNDLE.tweaks) results.push(await applyTweakForResult(id));
    for (const id of BATTERY_BUNDLE.cleanups) results.push(await runCleanupForResult(id));
    results.push(await applyBatteryOverlayNow());
    return finalizeApplyResult(profile, results);
  }

  try { await writeGameMode(1); const current = await readGameMode(); gameMode = current.exists && current.value === 1 ? { setting: 'Game Mode', status: 'success', message: 'Ativado para o usuário atual.' } : { setting: 'Game Mode', status: 'failed', message: 'O Windows não confirmou a ativação.' }; } catch { gameMode = { setting: 'Game Mode', status: 'failed', message: 'Não foi possível ativar o Game Mode.' }; }
  const results = [power, gameMode];
  // pacote curado do Gamer: mesmos ajustes reversíveis da tela de Ajustes individuais,
  // aplicados juntos. Um item bloqueado (ex.: exige administrador) aparece como
  // "failed" na lista, sem impedir os demais — igual ao plano de energia hoje.
  for (const id of GAMER_BUNDLE.tweaks) results.push(await applyTweakForResult(id));
  for (const id of GAMER_BUNDLE.cleanups) results.push(await runCleanupForResult(id));
  results.push(await applyGamerOverlayNow());
  return finalizeApplyResult(profile, results);
}

async function buildDiagnostics() {
  const [system, profiles, tweaks, history] = await Promise.all([getSystemInfo(), profileState().catch(() => null), tweaksState().catch(() => null), readHistory()]);
  return { generatedAt: new Date().toISOString(), appVersion: app.getVersion(), system, profiles, tweaks, history };
}

async function exportDiagnostics() {
  const diagnostics = await buildDiagnostics();
  const defaultName = `amaral-boost-diagnostico-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar diagnóstico',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { exported: false };
  try {
    await fs.writeFile(filePath, JSON.stringify(diagnostics, null, 2), 'utf8');
    return { exported: true, filePath };
  } catch {
    return { exported: false, error: 'Não foi possível salvar o arquivo de diagnóstico.' };
  }
}

// ---------- Atualizações: verificação manual contra os Releases do GitHub ----------
// Só consulta a internet quando a pessoa abre a aba (ou clica em "Verificar
// agora") — nada roda em segundo plano nem baixa/instala nada sozinho. Cada
// versão publicada deve virar um Release no repositório GITHUB_REPO com a tag
// no formato vX.Y.Z (ex.: v0.3.0); é essa tag que vira "latestVersion" aqui.

function compareVersions(a, b) {
  const partsA = String(a).split('.').map(part => parseInt(part, 10) || 0);
  const partsB = String(b).split('.').map(part => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: { 'User-Agent': 'amaral-boost-app', Accept: 'application/vnd.github+json' },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return reject(new Error('Nenhum Release publicado ainda.'));
        if (res.statusCode !== 200) return reject(new Error(`O GitHub respondeu com erro ${res.statusCode}.`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Resposta inesperada do GitHub.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado ao consultar o GitHub.')));
    req.on('error', () => reject(new Error('Não foi possível conectar ao GitHub. Verifique sua internet.')));
  });
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  try {
    const release = await fetchLatestRelease();
    const latestVersion = String(release.tag_name || '').trim().replace(/^v/i, '');
    if (!latestVersion) throw new Error('O Release mais recente não tem uma tag de versão válida.');
    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
      releaseNotes: typeof release.body === 'string' ? release.body : '',
      publishedAt: release.published_at || null
    };
  } catch (error) {
    return { ok: false, currentVersion, error: error.message || 'Não foi possível verificar atualizações.' };
  }
}

// Só permite abrir links https://github.com/... vindos da checagem de
// atualização — evita virar um "abridor de qualquer URL" genérico exposto ao
// renderer só porque esta tela precisa abrir um link.
async function openExternalLink(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' || !/(^|\.)github\.com$/i.test(parsed.hostname)) return { ok: false };
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// A barra de título é desenhada pelo Windows, não pela página — CSS não alcança.
// DWMWA_CAPTION_COLOR (Windows 11 22H2+) deixa o DWM recolorir só a barra nativa,
// mantendo ícone, texto e os três botões exatamente como são; DWMWA_TEXT_COLOR
// escurece o padrão pra continuar legível num fundo escuro. Em Windows mais
// antigo esses atributos não existem: a chamada falha e a barra fica no padrão
// do sistema, sem quebrar o app.
const TITLE_BAR_CAPTION_COLORREF = '0x211811'; // BGR de #111821 (--panel)
const TITLE_BAR_TEXT_COLORREF = '0xF7F2ED'; // BGR de #edf2f7 (--text)

function windowHandleAsDecimal(win) {
  const buffer = win.getNativeWindowHandle();
  return (buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))).toString();
}

async function applyDarkTitleBar(win) {
  if (process.platform !== 'win32') return;
  const script = `
    Add-Type -Name Dwm -Namespace AmaralBoost -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);'
    $hwnd = [IntPtr]([Int64]${windowHandleAsDecimal(win)})
    $darkMode = 1
    [AmaralBoost.Dwm]::DwmSetWindowAttribute($hwnd, 20, [ref]$darkMode, 4) | Out-Null
    $captionColor = ${TITLE_BAR_CAPTION_COLORREF}
    [AmaralBoost.Dwm]::DwmSetWindowAttribute($hwnd, 35, [ref]$captionColor, 4) | Out-Null
    $textColor = ${TITLE_BAR_TEXT_COLORREF}
    [AmaralBoost.Dwm]::DwmSetWindowAttribute($hwnd, 36, [ref]$textColor, 4) | Out-Null
  `;
  await runPowerShellScript(script, 8000).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: '#0a0e13',
    title: 'Amaral Boost',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyDarkTitleBar(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', async event => {
    if (isQuitting) return;
    event.preventDefault();
    if (isClosePromptOpen) return;
    isClosePromptOpen = true;
    try {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Fechar completamente', 'Manter em segundo plano'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Amaral Boost',
        message: 'Como você deseja fechar o Amaral Boost?',
        detail: 'Manter em segundo plano deixa o app disponível no ícone da área de notificação do Windows.'
      });
      if (choice.response === 0) { isQuitting = true; app.quit(); }
      else mainWindow.hide();
    } finally {
      isClosePromptOpen = false;
    }
  });
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  // nativeImage não sabe renderizar SVG (fica em branco na bandeja); usa o PNG gerado a partir dele.
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Amaral Boost');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Amaral Boost', click: showMainWindow },
    { type: 'separator' },
    { label: 'Fechar completamente', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
}

app.whenReady().then(() => {
  ipcMain.handle('system:get-info', getSystemInfo);
  ipcMain.handle('performance:get-specs', () => readPerformanceSpecs());
  ipcMain.handle('performance:get-live', () => getPerformanceLive());
  ipcMain.handle('profiles:get-state', profileState);
  ipcMain.handle('profiles:apply', (_event, profile) => applyProfile(profile));
  ipcMain.handle('history:get', () => readHistory());
  ipcMain.handle('history:clear', async () => { await writeHistoryFile([]); return { cleared: true }; });
  ipcMain.handle('diagnostics:export', () => exportDiagnostics());
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('tweaks:get-catalog', () => tweaksCatalog());
  ipcMain.handle('tweaks:get-state', () => tweaksState());
  ipcMain.handle('tweaks:apply', (_event, id) => applyTweakById(id));
  ipcMain.handle('tweaks:revert', (_event, id) => revertTweakByIdHandler(id));
  ipcMain.handle('tweaks:run-cleanup', (_event, id) => runCleanupById(id));
  ipcMain.handle('ram:get-state', () => ramLimit.getState());
  ipcMain.handle('ram:enable', (_event, limitMB) => enableRamLimit(limitMB));
  ipcMain.handle('ram:disable', () => disableRamLimit());
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('app:open-external', (_event, url) => openExternalLink(url));
  createWindow();
  createTray();
  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });
