// Amaral Boost — núcleo do "Modo durante o jogo".
//
// Compilado em tempo de execução por um PowerShell auxiliar (ver
// game-session.js). A cada Tick(): descobre se a janela em primeiro plano é de
// um jogo conhecido; se for, dá prioridade Alta ao processo do jogo e aplica
// EcoQoS (o "modo de eficiência" do Gerenciador de Tarefas, sem a prioridade
// ociosa) em apps de segundo plano elegíveis. Assim que o jogo sai do primeiro
// plano, tudo volta.
//
// Regras que vêm de medição real, não de gosto:
// - Só entra em EcoQoS um processo com ControlMask == 0, ou seja, que ninguém
//   gerencia. Chrome/Brave já põem abas escondidas em EcoQoS por conta própria
//   e marcam áudio e GPU como "não mexer" (ControlMask 4); respeitar isso é o
//   que impede cortar a música do navegador durante o jogo.
// - Cada processo é avaliado UMA vez por sessão. Se o próprio app mudar o
//   estado depois, ele manda: não reaplicamos, e na saída não restauramos por
//   cima do que ele decidiu.
// - Identidade = PID + horário de criação, para nunca mexer num processo novo
//   que reaproveitou o PID de um antigo.
// - Tudo que foi alterado vai para um arquivo de recuperação: se o app morrer
//   no meio, a próxima execução devolve o que ainda estiver vivo.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class AmaralGameSession
{
    const uint PROCESS_SET_INFORMATION = 0x0200;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_SET_LIMITED_INFORMATION = 0x2000;
    const uint SYNCHRONIZE = 0x00100000;
    const int ProcessPowerThrottling = 4;
    const int ProcessCommandLineInformation = 60;
    const uint EXECUTION_SPEED = 0x1;
    const uint HIGH_PRIORITY_CLASS = 0x80;
    const uint REALTIME_PRIORITY_CLASS = 0x100;
    const uint WAIT_TIMEOUT = 0x102;
    // Ticks seguidos fora do jogo antes de restaurar: absorve popups curtos
    // (notificação, Game Bar) sem ficar ligando e desligando tudo.
    const int AWAY_TICKS_TO_RESTORE = 2;

    [StructLayout(LayoutKind.Sequential)]
    struct PowerThrottlingState { public uint Version; public uint ControlMask; public uint StateMask; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(IntPtr process, int infoClass, ref PowerThrottlingState info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PowerThrottlingState info, int size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr process);
    [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr process, uint priorityClass);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr buffer, int length, out int returned);

    sealed class GameRule { public string Path; public bool IsDirectory; public string Name; }
    sealed class Throttled { public long Created; public uint PrevControl; public uint PrevState; }
    sealed class Boosted { public int Pid; public long Created; public uint PrevClass; }

    static List<GameRule> rules = new List<GameRule>();
    static HashSet<string> backgroundApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static HashSet<string> chromiumBrowsers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static string recoveryFile;

    static readonly Dictionary<int, Throttled> throttled = new Dictionary<int, Throttled>();
    static readonly HashSet<string> decided = new HashSet<string>();
    static Boosted boosted;
    static bool inGame;
    static int awayTicks;
    static int gamePid;
    static string gameName = "";
    static string priority = "none";

    public static void Configure(string[] paths, string[] kinds, string[] names, string[] background, string[] chromium, string recoveryPath)
    {
        var next = new List<GameRule>();
        for (int i = 0; i < paths.Length; i++)
        {
            if (string.IsNullOrEmpty(paths[i])) continue;
            bool isDir = kinds[i] == "dir";
            next.Add(new GameRule { Path = isDir ? paths[i].TrimEnd('\\') + "\\" : paths[i], IsDirectory = isDir, Name = names[i] });
        }
        rules = next;
        backgroundApps = new HashSet<string>(background, StringComparer.OrdinalIgnoreCase);
        chromiumBrowsers = new HashSet<string>(chromium, StringComparer.OrdinalIgnoreCase);
        recoveryFile = recoveryPath;
    }

    // foregroundOverride > 0 só é usado por testes automatizados, que não
    // conseguem colocar uma janela em primeiro plano.
    public static string Tick(int foregroundOverride)
    {
        int foreground = foregroundOverride > 0 ? foregroundOverride : ForegroundPid();
        string name = foreground > 0 ? MatchGame(foreground) : null;
        if (name != null)
        {
            awayTicks = 0;
            if (!inGame || gamePid != foreground)
            {
                if (inGame) RestoreAll();
                inGame = true;
                gamePid = foreground;
                gameName = name;
                BoostGame(foreground);
            }
            ThrottleBackground(foreground);
        }
        else if (inGame && ++awayTicks >= AWAY_TICKS_TO_RESTORE)
        {
            RestoreAll();
        }
        return Status();
    }

    public static string Status()
    {
        return "{\"type\":\"status\",\"inGame\":" + (inGame ? "true" : "false") +
               ",\"game\":" + Json(gameName) +
               ",\"priority\":" + Json(priority) +
               ",\"throttled\":" + throttled.Count + "}";
    }

    public static void RestoreAll()
    {
        foreach (var pair in throttled) RestoreThrottled(pair.Key, pair.Value);
        throttled.Clear();
        if (boosted != null) RestoreBoosted(boosted);
        boosted = null;
        decided.Clear();
        inGame = false;
        awayTicks = 0;
        gamePid = 0;
        gameName = "";
        priority = "none";
        SaveRecovery();
    }

    public static int Recover(string path)
    {
        recoveryFile = path;
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return 0;
        int restored = 0;
        foreach (var line in File.ReadAllLines(path))
        {
            var parts = line.Split('|');
            try
            {
                if (parts[0] == "T" && parts.Length == 5)
                {
                    if (RestoreThrottled(int.Parse(parts[1]), new Throttled { Created = long.Parse(parts[2]), PrevControl = uint.Parse(parts[3]), PrevState = uint.Parse(parts[4]) })) restored++;
                }
                else if (parts[0] == "B" && parts.Length == 4)
                {
                    if (RestoreBoosted(new Boosted { Pid = int.Parse(parts[1]), Created = long.Parse(parts[2]), PrevClass = uint.Parse(parts[3]) })) restored++;
                }
            }
            catch { /* linha corrompida: ignora só ela */ }
        }
        File.Delete(path);
        return restored;
    }

    // A entrada padrão é lida numa thread própria. No PowerShell 5.1,
    // [Console]::In.ReadLineAsync() NÃO é assíncrono (o leitor é sincronizado)
    // e travava o loop inteiro na primeira leitura: nenhum Tick rodava.
    static volatile bool stopRequested;
    public static bool StopRequested { get { return stopRequested; } }

    public static void WatchStdin()
    {
        var thread = new System.Threading.Thread(() =>
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null || line.Trim() == "stop") { stopRequested = true; return; }
                }
            }
            catch { stopRequested = true; }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    public static bool IsAlive(int pid)
    {
        IntPtr handle = OpenProcess(SYNCHRONIZE, false, pid);
        if (handle == IntPtr.Zero) return false;
        try { return WaitForSingleObject(handle, 0) == WAIT_TIMEOUT; }
        finally { CloseHandle(handle); }
    }

    // ---------- jogo ----------

    static int ForegroundPid()
    {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return (int)pid;
    }

    static string MatchGame(int pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return null;
        try { return MatchGamePath(ImagePath(handle)); }
        finally { CloseHandle(handle); }
    }

    static string MatchGamePath(string image)
    {
        if (image == null) return null;
        foreach (var rule in rules)
        {
            if (rule.IsDirectory ? image.StartsWith(rule.Path, StringComparison.OrdinalIgnoreCase)
                                 : string.Equals(image, rule.Path, StringComparison.OrdinalIgnoreCase))
                return rule.Name;
        }
        return null;
    }

    static void BoostGame(int pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION, false, pid);
        // Anti-cheats costumam negar esse acesso ao processo do jogo; não é erro.
        if (handle == IntPtr.Zero) { priority = "denied"; return; }
        try
        {
            uint current = GetPriorityClass(handle);
            if (current == HIGH_PRIORITY_CLASS || current == REALTIME_PRIORITY_CLASS) { priority = "already"; return; }
            if (current == 0 || !SetPriorityClass(handle, HIGH_PRIORITY_CLASS)) { priority = "denied"; return; }
            boosted = new Boosted { Pid = pid, Created = Created(handle), PrevClass = current };
            priority = "high";
            SaveRecovery();
        }
        finally { CloseHandle(handle); }
    }

    static bool RestoreBoosted(Boosted entry)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION, false, entry.Pid);
        if (handle == IntPtr.Zero) return false;
        try
        {
            if (Created(handle) != entry.Created) return false;
            // Se alguém mudou a prioridade depois, a decisão é de quem mudou.
            if (GetPriorityClass(handle) != HIGH_PRIORITY_CLASS) return false;
            return SetPriorityClass(handle, entry.PrevClass);
        }
        finally { CloseHandle(handle); }
    }

    // ---------- apps de segundo plano ----------

    static void ThrottleBackground(int gameProcess)
    {
        bool changed = false;

        // Limpa quem morreu ou teve o estado mudado pelo próprio app.
        foreach (int pid in new List<int>(throttled.Keys))
        {
            var entry = throttled[pid];
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            bool keep = false;
            if (handle != IntPtr.Zero)
            {
                try
                {
                    var state = new PowerThrottlingState { Version = 1 };
                    keep = Created(handle) == entry.Created &&
                           GetProcessInformation(handle, ProcessPowerThrottling, ref state, Marshal.SizeOf(state)) &&
                           state.ControlMask == EXECUTION_SPEED && state.StateMask == EXECUTION_SPEED;
                }
                finally { CloseHandle(handle); }
            }
            if (!keep) { throttled.Remove(pid); changed = true; }
        }

        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                int pid = process.Id;
                if (pid == gameProcess || throttled.ContainsKey(pid)) continue;
                string name = process.ProcessName;
                bool chromium = chromiumBrowsers.Contains(name);
                if (!chromium && !backgroundApps.Contains(name)) continue;

                IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_LIMITED_INFORMATION, false, pid);
                if (handle == IntPtr.Zero) continue;
                try
                {
                    long created = Created(handle);
                    if (!decided.Add(pid + ":" + created)) continue;
                    if (MatchGamePath(ImagePath(handle)) != null) continue;
                    // Do navegador, só processo de extensão: o resto (principal,
                    // rede, DRM, aba visível) pode estar tocando áudio ou stream.
                    if (chromium && !IsChromiumExtension(handle)) continue;

                    var state = new PowerThrottlingState { Version = 1 };
                    if (!GetProcessInformation(handle, ProcessPowerThrottling, ref state, Marshal.SizeOf(state))) continue;
                    if (state.ControlMask != 0) continue;

                    var eco = new PowerThrottlingState { Version = 1, ControlMask = EXECUTION_SPEED, StateMask = EXECUTION_SPEED };
                    if (SetProcessInformation(handle, ProcessPowerThrottling, ref eco, Marshal.SizeOf(eco)))
                    {
                        throttled[pid] = new Throttled { Created = created, PrevControl = state.ControlMask, PrevState = state.StateMask };
                        changed = true;
                    }
                }
                finally { CloseHandle(handle); }
            }
        }
        if (changed) SaveRecovery();
    }

    static bool RestoreThrottled(int pid, Throttled entry)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return false;
        try
        {
            if (Created(handle) != entry.Created) return false;
            var state = new PowerThrottlingState { Version = 1 };
            if (!GetProcessInformation(handle, ProcessPowerThrottling, ref state, Marshal.SizeOf(state))) return false;
            if (state.ControlMask != EXECUTION_SPEED || state.StateMask != EXECUTION_SPEED) return false;
            var previous = new PowerThrottlingState { Version = 1, ControlMask = entry.PrevControl, StateMask = entry.PrevState };
            return SetProcessInformation(handle, ProcessPowerThrottling, ref previous, Marshal.SizeOf(previous));
        }
        finally { CloseHandle(handle); }
    }

    static bool IsChromiumExtension(IntPtr handle)
    {
        string commandLine = CommandLine(handle);
        return commandLine != null && commandLine.Contains("--type=renderer") && commandLine.Contains("--extension-process");
    }

    // ---------- utilitários ----------

    static long Created(IntPtr handle)
    {
        long creation, exit, kernel, user;
        return GetProcessTimes(handle, out creation, out exit, out kernel, out user) ? creation : -1;
    }

    static string ImagePath(IntPtr handle)
    {
        var builder = new StringBuilder(1024);
        int size = builder.Capacity;
        return QueryFullProcessImageName(handle, 0, builder, ref size) ? builder.ToString() : null;
    }

    static string CommandLine(IntPtr handle)
    {
        int length;
        NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
        if (length <= 0 || length > 1 << 20) return null;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, length, out length) != 0) return null;
            int bytes = Marshal.ReadInt16(buffer) & 0xFFFF;
            IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
            return text == IntPtr.Zero ? null : Marshal.PtrToStringUni(text, bytes / 2);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static void SaveRecovery()
    {
        if (string.IsNullOrEmpty(recoveryFile)) return;
        var lines = new List<string>();
        foreach (var pair in throttled) lines.Add("T|" + pair.Key + "|" + pair.Value.Created + "|" + pair.Value.PrevControl + "|" + pair.Value.PrevState);
        if (boosted != null) lines.Add("B|" + boosted.Pid + "|" + boosted.Created + "|" + boosted.PrevClass);
        try
        {
            if (lines.Count == 0) { if (File.Exists(recoveryFile)) File.Delete(recoveryFile); }
            else File.WriteAllLines(recoveryFile, lines.ToArray());
        }
        catch { /* sem arquivo de recuperação o modo continua funcionando */ }
    }

    static string Json(string value)
    {
        var builder = new StringBuilder("\"");
        foreach (char c in value ?? "")
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.Append('"').ToString();
    }
}
