/**
 * Amaral Boost — limite de RAM para navegadores (Gerenciamento de RAM).
 *
 * Diferente do resto do app (chaves de registro, plano de energia, Game
 * Mode), isto NÃO é revertível instantaneamente: um Job Object do Windows,
 * uma vez com um processo dentro, não pode "soltar" esse processo — só
 * impedir que processos novos entrem. Ver README para o efeito completo.
 *
 * Mecanismo: um script PowerShell auxiliar (gerado aqui, salvo em userData)
 * roda em loop contínuo, cria um Job Object com JobMemoryLimit e vai
 * atribuindo a ele todo processo de navegador reconhecido que aparecer. Esse
 * script roda como Tarefa Agendada (Register-ScheduledTask), não como filho
 * direto do processo do Electron: assim ele sobrevive a "Fechar
 * completamente" do Amaral Boost. A tarefa é criada com disparo único e
 * imediato — não fica registrada para rodar no próximo boot/logon.
 *
 * Usa os cmdlets do módulo ScheduledTasks (Get-ScheduledTask etc.) em vez de
 * ler a saída texto do schtasks.exe: os cmdlets devolvem objetos .NET com
 * nomes de enum fixos, enquanto o texto do schtasks.exe é localizado (mesmo
 * cuidado documentado em main.js para Get-Counter vs. WMI).
 */

const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const TASK_NAME = 'AmaralBoostRamLimit';
const MIN_LIMIT_MB = 1024; // 1 GB — abaixo disso o Windows e o próprio navegador já não sobem sozinhos.
const RESERVE_MB = 1024; // nunca deixa configurar um teto que não sobre pelo menos 1 GB pro resto do sistema.

const RECOGNIZED_BROWSERS = [
  { process: 'chrome', label: 'Google Chrome' },
  { process: 'msedge', label: 'Microsoft Edge' },
  { process: 'firefox', label: 'Mozilla Firefox' },
  { process: 'brave', label: 'Brave' },
  { process: 'opera', label: 'Opera' },
  { process: 'opera_gx', label: 'Opera GX' },
  { process: 'vivaldi', label: 'Vivaldi' },
  { process: 'iexplore', label: 'Internet Explorer' }
];

function getStatePath() {
  return path.join(app.getPath('userData'), 'amaral-boost-ram-limit-state.json');
}

function getHelperScriptPath() {
  return path.join(app.getPath('userData'), 'amaral-boost-ram-limit-helper.ps1');
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(getStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? { enabled: false, limitMB: null, enabledAt: null, ...parsed } : { enabled: false, limitMB: null, enabledAt: null };
  } catch {
    return { enabled: false, limitMB: null, enabledAt: null };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(getStatePath()), { recursive: true });
  await fs.writeFile(getStatePath(), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function runPS(script, timeout = 15000) {
  const safeScript = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ' + script;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', safeScript], { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function processNamesLiteral() {
  return RECOGNIZED_BROWSERS.map(browser => `'${browser.process}'`).join(', ');
}

function clampLimitMB(requestedMB, totalMB) {
  const max = Math.max(MIN_LIMIT_MB, totalMB - RESERVE_MB);
  const min = MIN_LIMIT_MB;
  const requested = Number.isFinite(requestedMB) ? Math.round(requestedMB) : min;
  return Math.min(max, Math.max(min, requested));
}

async function readTaskState() {
  const script = `
    $task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
    if ($task) { [pscustomobject]@{ exists = $true; state = $task.State.ToString() } | ConvertTo-Json -Compress }
    else { [pscustomobject]@{ exists = $false; state = $null } | ConvertTo-Json -Compress }
  `;
  try {
    return JSON.parse((await runPS(script, 8000)) || '{}');
  } catch {
    return { exists: false, state: null };
  }
}

// Uma chamada só ao PowerShell agrupa TODOS os processos por nome (como o
// Gerenciador de Tarefas faz com "chrome.exe (14)") e devolve dois recortes
// do mesmo agrupamento: só os navegadores reconhecidos (pro card do limite) e
// o top N geral do sistema (pro card "o que está consumindo RAM agora",
// pedido explicitamente pelo usuário — não é só sobre navegador).
async function readMemoryBreakdown(topCount = 12) {
  const script = `
    $names = @(${processNamesLiteral()})
    $all = Get-Process -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object {
      $bytes = ($_.Group | Measure-Object -Property WorkingSet64 -Sum).Sum
      [pscustomobject]@{ name = $_.Name; bytes = $bytes; count = $_.Count }
    }
    $browsers = $all | Where-Object { $names -contains $_.name }
    $top = $all | Sort-Object -Property bytes -Descending | Select-Object -First ${topCount}
    [pscustomobject]@{ browsers = @($browsers); top = @($top) } | ConvertTo-Json -Compress -Depth 4
  `;
  const toMB = bytes => Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null;
  try {
    const parsed = JSON.parse((await runPS(script, 8000)) || '{}');
    const browsersRaw = Array.isArray(parsed.browsers) ? parsed.browsers : (parsed.browsers ? [parsed.browsers] : []);
    const topRaw = Array.isArray(parsed.top) ? parsed.top : (parsed.top ? [parsed.top] : []);
    const browsers = RECOGNIZED_BROWSERS.map(browser => {
      const match = browsersRaw.find(item => item.name === browser.process);
      return match ? { ...browser, mb: toMB(match.bytes), count: match.count } : null;
    }).filter(Boolean);
    const topProcesses = topRaw.map(item => ({ name: item.name, mb: toMB(item.bytes), count: item.count }));
    return {
      browsers,
      totalBrowsersMB: browsers.reduce((sum, browser) => sum + (browser.mb || 0), 0),
      totalBrowsersCount: browsers.reduce((sum, browser) => sum + (browser.count || 0), 0),
      topProcesses
    };
  } catch {
    return { browsers: [], totalBrowsersMB: null, totalBrowsersCount: 0, topProcesses: [] };
  }
}

async function getState() {
  if (process.platform !== 'win32') return { supported: false };
  const persisted = await readState();
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const [taskState, breakdown] = await Promise.all([readTaskState(), readMemoryBreakdown()]);
  return {
    supported: true,
    enabled: Boolean(persisted.enabled),
    limitMB: persisted.limitMB || null,
    enabledAt: persisted.enabledAt || null,
    totalMemMB: totalMB,
    minLimitMB: MIN_LIMIT_MB,
    maxLimitMB: Math.max(MIN_LIMIT_MB, totalMB - RESERVE_MB),
    running: taskState.exists && taskState.state === 'Running',
    taskExists: Boolean(taskState.exists),
    browsersUsageMB: breakdown.totalBrowsersMB,
    browsersRunningCount: breakdown.totalBrowsersCount,
    browsersBreakdown: breakdown.browsers,
    topProcesses: breakdown.topProcesses,
    recognizedBrowsers: RECOGNIZED_BROWSERS
  };
}

// Script auxiliar: cria o Job Object com o teto de memória (via P/Invoke, a
// mesma técnica de Add-Type já usada em main.js/tweaks.js, só que com uma
// classe C# inteira em vez de uma assinatura solta, porque monta uma struct)
// e fica em loop atribuindo a ele todo processo de navegador reconhecido.
function buildHelperScript(limitBytes) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace AmaralBoost {
  public class RamJob {
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
      public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
      public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int cls, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    public static IntPtr CreateLimitedJob(long limitBytes) {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObjectW failed");
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = 0x00000200; // JOB_OBJECT_LIMIT_JOB_MEMORY
      info.JobMemoryLimit = (UIntPtr)(ulong)limitBytes;
      int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr ptr = Marshal.AllocHGlobal(len);
      try {
        Marshal.StructureToPtr(info, ptr, false);
        if (!SetInformationJobObject(job, 9, ptr, (uint)len)) throw new InvalidOperationException("SetInformationJobObject failed");
      } finally { Marshal.FreeHGlobal(ptr); }
      return job;
    }
    public static bool TryAssign(IntPtr job, int pid) {
      IntPtr proc = OpenProcess(0x0101 /* PROCESS_TERMINATE | PROCESS_SET_QUOTA */, false, pid);
      if (proc == IntPtr.Zero) return false;
      try { return AssignProcessToJobObject(job, proc); } finally { CloseHandle(proc); }
    }
  }
}
"@

$job = [AmaralBoost.RamJob]::CreateLimitedJob([int64]${limitBytes})
$names = @(${processNamesLiteral()})
$seen = New-Object 'System.Collections.Generic.HashSet[int]'
while ($true) {
  foreach ($proc in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName })) {
    if (-not $seen.Contains($proc.Id)) {
      [void][AmaralBoost.RamJob]::TryAssign($job, $proc.Id)
      [void]$seen.Add($proc.Id)
    }
  }
  Start-Sleep -Seconds 3
}
`;
}

async function removeExistingTask() {
  await runPS(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`, 10000).catch(() => {});
}

async function enable(requestedLimitMB) {
  if (process.platform !== 'win32') return { ok: false, message: 'Este recurso está disponível somente no Windows.' };
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const limitMB = clampLimitMB(requestedLimitMB, totalMB);
  const limitBytes = limitMB * 1024 * 1024;
  const scriptPath = getHelperScriptPath();

  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, buildHelperScript(limitBytes), { encoding: 'utf8', mode: 0o600 });

  // recria do zero se já existia (ex.: usuário mudou o valor do limite) — o
  // Job antigo, se ainda tiver navegadores dentro, continua valendo pra eles
  // por conta própria (ver nota no topo do arquivo); isto só troca o auxiliar
  // que passa a atribuir processos novos ao Job novo, com o limite novo.
  await removeExistingTask();

  const quotedScriptPath = scriptPath.replace(/'/g, "''");
  const registerScript = `
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${quotedScriptPath}"'
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -RunLevel Highest -LogonType Interactive
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName '${TASK_NAME}'
  `;
  try {
    await runPS(registerScript, 15000);
  } catch {
    return { ok: false, message: 'Não foi possível criar a tarefa agendada que aplica o limite. Verifique se o Agendador de Tarefas do Windows está disponível.' };
  }

  await new Promise(resolve => setTimeout(resolve, 1200));
  const taskState = await readTaskState();
  const running = taskState.exists && taskState.state === 'Running';
  await writeState({ enabled: true, limitMB, enabledAt: new Date().toISOString() });

  return {
    ok: running,
    limitMB,
    message: running
      ? `Limite de ${(limitMB / 1024).toFixed(1)} GB ativado para os navegadores reconhecidos.`
      : 'A tarefa foi criada, mas o Windows ainda não confirmou que está em execução. Reabra esta tela em alguns segundos para conferir.'
  };
}

async function disable() {
  if (process.platform !== 'win32') return { ok: false, message: 'Este recurso está disponível somente no Windows.' };
  const previous = await readState();
  try {
    await removeExistingTask();
  } catch {
    // segue mesmo se falhar — o estado local abaixo ainda reflete a intenção do usuário
  }
  await writeState({ enabled: false, limitMB: previous.limitMB || null, enabledAt: null });
  return {
    ok: true,
    message: 'Desativado: nenhum processo novo de navegador será mais colocado no limite. Navegadores que já estavam dentro do limite continuam restritos até serem fechados — o Windows não permite "soltar" um processo de um limite de memória sem fechá-lo.'
  };
}

module.exports = { RECOGNIZED_BROWSERS, MIN_LIMIT_MB, getState, enable, disable };
