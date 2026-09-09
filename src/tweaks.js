/**
 * Amaral Boost — catálogo de ajustes individuais.
 *
 * Cada ajuste é declarativo: `regOps` lista as chaves de registro que ele muda.
 * O motor genérico (main.js) lê o valor atual de cada chave ANTES de escrever,
 * guarda esse valor como backup e usa exatamente ele para reverter depois —
 * nunca "adivinha" um padrão do Windows.
 *
 * `admin: true` marca ajustes que só funcionam com o Amaral Boost aberto como
 * administrador (mudam HKLM, que é da máquina toda, não só do usuário atual).
 * `notWhen` explica em texto quando a pessoa pode preferir NÃO ativar o ajuste.
 *
 * Nenhum ajuste aqui mexe em arquivos, processos, serviços, rede além de uma
 * chave pontual, ou segurança. Cada um foi escolhido por ser revertível de
 * forma exata, com efeito simples de explicar.
 */

const TWEAKS = [
  {
    id: 'game-dvr-off',
    name: 'Desativar Game DVR em segundo plano',
    desc: 'Para a gravação automática da Xbox Game Bar em segundo plano, que pode consumir desempenho sem avisar.',
    notWhen: 'você usa a Xbox Game Bar de propósito para gravar seus jogos.',
    tags: ['gaming'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'DWord', value: 0 },
      { hive: 'HKCU', key: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', type: 'DWord', value: 0 }
    ]
  },
  {
    id: 'sticky-keys-off',
    name: 'Desativar popups de Sticky Keys',
    desc: 'Impede que apertar Shift, Ctrl ou Alt cinco vezes seguidas abra a janela de teclas de aderência.',
    notWhen: 'você usa Sticky Keys, Toggle Keys ou Filter Keys por acessibilidade.',
    tags: ['geral'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'Control Panel\\Accessibility\\StickyKeys', name: 'Flags', type: 'String', value: '506' },
      { hive: 'HKCU', key: 'Control Panel\\Accessibility\\ToggleKeys', name: 'Flags', type: 'String', value: '58' },
      { hive: 'HKCU', key: 'Control Panel\\Accessibility\\Keyboard Response', name: 'Flags', type: 'String', value: '122' }
    ]
  },
  {
    id: 'advertising-id-off',
    name: 'Desativar ID de publicidade',
    desc: 'Impede que aplicativos usem seu ID de anúncios do Windows para rastreamento entre apps.',
    tags: ['privacidade'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', name: 'Enabled', type: 'DWord', value: 0 }
    ]
  },
  {
    id: 'bing-search-off',
    name: 'Desativar busca Bing no menu Iniciar',
    desc: 'O menu Iniciar passa a buscar somente no seu computador, sem resultados da web.',
    tags: ['privacidade'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Search', name: 'BingSearchEnabled', type: 'DWord', value: 0 }
    ]
  },
  {
    id: 'notifications-off',
    name: 'Desativar notificações do Windows',
    desc: 'Impede os popups de notificação (toasts) de aparecerem no canto da tela. Cada toast acende a tela e acorda processos em segundo plano.',
    notWhen: 'você depende de lembretes de calendário, e-mail ou de outros apps por notificação.',
    tags: ['geral', 'privacidade', 'bateria'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', name: 'ToastEnabled', type: 'DWord', value: 0 }
    ]
  },
  {
    id: 'network-throttling-off',
    name: 'Desativar limitação de rede',
    desc: 'Remove o limite de pacotes por milissegundo que o Windows aplica por padrão. Ajuste clássico para reduzir ping em jogos.',
    tags: ['rede'],
    admin: true,
    regOps: [
      { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', name: 'NetworkThrottlingIndex', type: 'DWord', value: 0xffffffff }
    ]
  },
  {
    id: 'file-extensions-on',
    name: 'Mostrar extensões de arquivo',
    desc: 'O Explorador de Arquivos passa a exibir .exe, .pdf, .txt junto do nome de cada arquivo.',
    tags: ['geral'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'HideFileExt', type: 'DWord', value: 0 }
    ]
  },
  {
    id: 'games-priority',
    name: 'Prioridade máxima para jogos',
    desc: 'Ajusta o perfil "Jogos" do Windows: mais prioridade de GPU e CPU para a tarefa em primeiro plano.',
    tags: ['gaming'],
    admin: true,
    regOps: [
      { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games', name: 'GPU Priority', type: 'DWord', value: 8 },
      { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games', name: 'Priority', type: 'DWord', value: 6 },
      { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games', name: 'Scheduling Category', type: 'String', value: 'High' }
    ]
  },
  {
    id: 'system-responsiveness',
    name: 'Responsividade do sistema para jogos',
    desc: 'Reduz de 20% para 10% a fatia de CPU reservada para tarefas em segundo plano.',
    tags: ['gaming', 'desempenho'],
    admin: true,
    regOps: [
      { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', name: 'SystemResponsiveness', type: 'DWord', value: 10 }
    ]
  },
  {
    id: 'background-apps-off',
    name: 'Desativar apps da Store em segundo plano',
    desc: 'Impede que aplicativos da Microsoft Store rodem em segundo plano consumindo CPU e RAM.',
    tags: ['desempenho', 'bateria'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', name: 'GlobalUserDisabled', type: 'DWord', value: 1 }
    ]
  },
  {
    id: 'edge-preload-off',
    name: 'Desativar pré-carregamento do Edge',
    desc: 'Impede o Microsoft Edge de ficar residente na memória mesmo sem você abrir ele.',
    notWhen: 'você usa o Edge com frequência e prefere que ele abra mais rápido.',
    tags: ['desempenho', 'bateria'],
    admin: true,
    regOps: [
      { hive: 'HKLM', key: 'SOFTWARE\\Policies\\Microsoft\\Edge', name: 'StartupBoostEnabled', type: 'DWord', value: 0 },
      { hive: 'HKLM', key: 'SOFTWARE\\Policies\\Microsoft\\Edge', name: 'BackgroundModeEnabled', type: 'DWord', value: 0 }
    ]
  },
  {
    id: 'visual-effects-performance',
    name: 'Efeitos visuais: melhor desempenho',
    desc: 'Desativa animações, sombras e efeitos visuais do Windows de uma vez, liberando GPU fora do jogo.',
    notWhen: 'você prefere a aparência padrão do Windows, com animações e sombras.',
    tags: ['aparencia', 'desempenho', 'bateria'],
    admin: false,
    regOps: [
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects', name: 'VisualFXSetting', type: 'DWord', value: 2 }
    ]
  },
  {
    id: 'gamer-power-mode-max',
    name: 'Modo de Energia: desempenho máximo na tomada',
    desc: 'Ajusta o "Modo de Energia" do Windows (Configurações > Energia e bateria) para Desempenho Máximo enquanto o notebook está na tomada, sem mexer no modo usado na bateria.',
    notWhen: 'você prefere escolher manualmente o "Modo de Energia" em Configurações do Windows.',
    tags: ['gaming', 'desempenho'],
    admin: true,
    regOps: [
      { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes', name: 'ActiveOverlayAcPowerScheme', type: 'String', value: 'ded574b5-45a0-4f42-8737-46345c09c238' }
    ]
  },
  {
    id: 'battery-power-mode-eco',
    name: 'Modo de Energia: economia na bateria',
    desc: 'Ajusta o "Modo de Energia" do Windows (Configurações > Energia e bateria) para Economia de energia sempre que o notebook estiver na bateria, sem mexer no modo usado conectado na tomada.',
    notWhen: 'você prefere escolher manualmente o "Modo de Energia" em Configurações do Windows.',
    tags: ['bateria', 'desempenho'],
    admin: true,
    regOps: [
      { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes', name: 'ActiveOverlayDcPowerScheme', type: 'String', value: '961cc777-2547-4f9d-8174-7d86181b8a7a' }
    ]
  }
];

/**
 * Ações de limpeza: rodam uma vez, não têm "estado aplicado" pra reverter
 * (não faria sentido reverter um flush de DNS ou uma pasta de temporários
 * esvaziada). A UI deixa isso explícito antes de confirmar.
 */
// A mensagem exibida ao usuário (`successMessage`) nunca vem do texto bruto
// do comando: programas nativos como o ipconfig escrevem no codepage OEM do
// Windows, que chega corrompido ao Node quando a saída é capturada. Rodar o
// comando serve só para executar a ação; quem descreve o resultado é o app.
const CLEANUPS = [
  {
    id: 'clean-temp',
    name: 'Limpar arquivos temporários',
    desc: 'Remove o conteúdo de %TEMP% e da pasta Temp do Windows. São arquivos descartáveis que o sistema recria quando precisa.',
    tags: ['limpeza'],
    // Um único "Remove-Item -Recurse -ErrorAction SilentlyContinue" sobre o
    // curinga não dá nenhum retorno útil: sucesso e "não removeu nada porque
    // tudo estava em uso" ficam indistinguíveis pro usuário. Aqui cada item de
    // topo é removido em try/catch isolado, então um arquivo travado (comum em
    // %TEMP%, que sempre tem coisa em uso) não afeta os outros, e o resultado
    // em JSON alimenta uma mensagem honesta em vez de um "sucesso" fixo.
    cmd: `
      $roots = @($env:TEMP, (Join-Path $env:WINDIR 'Temp'))
      $removed = 0; $failed = 0; $freedBytes = 0
      foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | ForEach-Object {
          $item = $_
          try {
            $size = if ($item.PSIsContainer) {
              (Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue |
                Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum
            } else { $item.Length }
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
            $removed++
            if ($size) { $freedBytes += $size }
          } catch { $failed++ }
        }
      }
      [pscustomobject]@{ removed = $removed; failed = $failed; freedMB = [math]::Round($freedBytes / 1MB, 1) } | ConvertTo-Json -Compress
    `,
    successMessage: 'Arquivos temporários removidos.'
  },
  {
    id: 'flush-dns',
    name: 'Limpar cache de DNS',
    desc: 'Executa a limpeza padrão do cache de DNS do Windows. Resolve lentidão de conexão por cache desatualizado.',
    tags: ['limpeza', 'rede'],
    cmd: 'ipconfig /flushdns | Out-Null',
    successMessage: 'Cache de DNS limpo.'
  },
  {
    id: 'standby-list',
    name: 'Liberar memória em standby',
    desc: 'Devolve ao sistema a RAM que processos abertos estão só guardando em cache, sem fechar nada.',
    tags: ['limpeza', 'gaming'],
    cmd: 'Add-Type -Name PS -Namespace AmaralBoost -MemberDefinition ' +
         '\'[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess);\'; ' +
         '$n = 0; Get-Process | Where-Object { $_.Id -ne $PID -and $_.ProcessName -notin @("csrss","winlogon","System","Idle","Memory Compression") } | ' +
         'ForEach-Object { try { if ([AmaralBoost.PS]::EmptyWorkingSet($_.Handle)) { $n++ } } catch {} }',
    successMessage: 'Memória em standby liberada.'
  }
];

/**
 * Pacote curado que o perfil Gamer aplica além de energia e Game Mode —
 * inspirado no "Competitivo Total" do Dilera Boost, mas sem nada trancado
 * atrás de pagamento e sem os itens de resultado inconsistente (agendamento
 * de GPU por hardware, compactação de memória): cada um aqui é uma mudança
 * pontual, de efeito conhecido e 100% revertível pelo Padrão Windows.
 */
const GAMER_BUNDLE = {
  tweaks: ['game-dvr-off', 'sticky-keys-off', 'network-throttling-off', 'games-priority', 'system-responsiveness', 'background-apps-off', 'edge-preload-off', 'visual-effects-performance', 'gamer-power-mode-max'],
  cleanups: ['standby-list']
};

/**
 * Pacote curado do perfil Economia de Bateria: só ajustes que reduzem
 * trabalho em segundo plano e uso de GPU/CPU fora do que a pessoa está
 * usando ativamente — nada de rede ou prioridade de jogos, que não têm
 * relação com consumo de energia. Cada item já existe no catálogo de
 * ajustes individuais e é 100% revertível pelo Padrão Windows.
 */
const BATTERY_BUNDLE = {
  tweaks: ['background-apps-off', 'edge-preload-off', 'visual-effects-performance', 'notifications-off', 'battery-power-mode-eco'],
  cleanups: []
};

module.exports = { TWEAKS, CLEANUPS, GAMER_BUNDLE, BATTERY_BUNDLE };
