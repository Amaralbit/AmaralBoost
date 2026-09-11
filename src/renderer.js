const state = { categories: new Set(['Inicialização', 'Armazenamento', 'Privacidade', 'Jogos']), history: [], selectedProfile: 'Padrão Windows', currentProfile: null, profileState: null, reviewMode: 'profile', tweaksCatalog: { tweaks: [], cleanups: [] }, tweaksState: { admin: false, applied: {} }, pendingTweakId: null, pendingTweakAction: null };
const profiles = {
  Equilibrado: { description: 'Ativa o plano Equilibrado do Windows e retorna o Game Mode ao estado original salvo.', effects: ['Plano de energia: ativar Equilibrado.', 'Game Mode: restaurar o estado original salvo.'] },
  Gamer: { description: 'Ativa Alto desempenho, liga o Game Mode e aplica um pacote de ajustes individuais de baixo risco voltado a jogos. Tudo revertível pelo Padrão Windows.', effects: ['Plano de energia: ativar Alto desempenho.', 'Game Mode: ativar para o usuário atual.'] },
  'Economia de Bateria': { description: 'Ativa o plano Economia de energia, desliga o Game Mode e aplica um pacote de ajustes individuais que reduzem trabalho em segundo plano. Tudo revertível pelo Padrão Windows.', effects: ['Plano de energia: ativar Economia de energia.', 'Game Mode: desativar para o usuário atual.'] },
  'Padrão Windows': { description: 'Restaura exatamente o plano de energia e o Game Mode que estavam ativos antes da primeira aplicação do Amaral Boost.', effects: ['Restauração: usa somente o snapshot local pré-Amaral.', 'Se não houver snapshot, nenhuma configuração será alterada.'] }
};

// os pacotes do Gamer e da Economia de Bateria vêm do catálogo (fonte única de
// verdade, ver tweaks.js no processo principal) em vez de uma lista fixa aqui,
// pra nunca desalinhar do que o perfil realmente aplica.
const PROFILE_BUNDLE_KEY = { Gamer: 'gamerBundle', 'Economia de Bateria': 'batteryBundle' };
function effectsFor(profileName) {
  const base = profiles[profileName].effects;
  const bundleKey = PROFILE_BUNDLE_KEY[profileName];
  if (!bundleKey) return base;
  const bundle = state.tweaksCatalog[bundleKey] || { tweaks: [], cleanups: [] };
  const tweakLines = bundle.tweaks.map(id => {
    const tweak = state.tweaksCatalog.tweaks.find(item => item.id === id);
    return tweak ? `Ajuste: ${tweak.name}${tweak.admin ? ' (exige administrador)' : ''}.` : null;
  }).filter(Boolean);
  const cleanupLines = bundle.cleanups.map(id => {
    const cleanup = state.tweaksCatalog.cleanups.find(item => item.id === id);
    return cleanup ? `Limpeza: ${cleanup.name}.` : null;
  }).filter(Boolean);
  return [...base, ...tweakLines, ...cleanupLines];
}
const toast = document.querySelector('#toast');
const modal = document.querySelector('#review-modal');
const reviewList = document.querySelector('#review-list');
const applyButton = document.querySelector('#apply-profile');
let toastTimer;

function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 3200); }
function switchView(view) {
  document.querySelectorAll('.view').forEach(element => element.classList.toggle('active-view', element.id === view));
  document.querySelectorAll('.nav-item').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  document.querySelector('#page-title').textContent = { dashboard: 'Visão geral', performance: 'Desempenho', profiles: 'Perfis', cleanups: 'Limpeza', ram: 'Gerenciamento de RAM', storage: 'Armazenamento', startup: 'Inicialização', history: 'Atividade', updates: 'Atualizações', donate: 'Doação', settings: 'Preferências' }[view];
  if (view === 'performance') startPerformancePolling(); else stopPerformancePolling();
  if (view === 'ram') startRamPolling(); else stopRamPolling();
  if (view === 'storage') loadStorageDrives();
  if (view === 'startup') loadStartupApps();
  // A checagem em si já roda sozinha ao abrir o app (ver bootstrap no fim do
  // arquivo); aqui só apaga a bolinha de aviso, porque o usuário acabou de ver.
  if (view === 'updates') document.querySelector('#updates-nav-dot').hidden = true;
}

// ---------- Desempenho: histórico curto em memória (só nesta sessão da tela) + mini-gráficos SVG ----------
const PERF_HISTORY_LEN = 30;
// Era 2500ms: a maior parte da demora percebida vinha de cada leitura abrir um
// powershell.exe novo (agora reaproveitado, ver runInPerfShell no processo
// principal), não deste intervalo. 1000ms casa com a taxa de atualização dos
// contadores de desempenho do próprio Windows (~1x/s), sem sobrecarregar à toa.
const PERF_POLL_MS = 1000;
const perf = { timerId: null, active: false, specsLoaded: false, cpuSpecBase: '', history: { cpu: [], mem: [], gpu: [], disk: [], net: [] } };

function pushPerfHistory(key, value) {
  const arr = perf.history[key];
  arr.push(typeof value === 'number' ? value : (arr.length ? arr[arr.length - 1] : 0));
  if (arr.length > PERF_HISTORY_LEN) arr.shift();
}

function sparklinePoints(arr, max) {
  if (arr.length < 2) return { line: '', area: '' };
  const stepX = 100 / (arr.length - 1);
  const scaleMax = max ?? Math.max(1, ...arr);
  const coords = arr.map((value, index) => {
    const x = +(index * stepX).toFixed(1);
    const clamped = Math.max(0, Math.min(scaleMax, value));
    const y = +(29 - (clamped / scaleMax) * 27).toFixed(1);
    return `${x},${y}`;
  });
  return { line: coords.join(' '), area: `0,30 ${coords.join(' ')} 100,30` };
}

function renderPerfChart(prefix, key, max) {
  const { line, area } = sparklinePoints(perf.history[key], max);
  document.querySelector(`#perf-${prefix}-line`).setAttribute('points', line);
  document.querySelector(`#perf-${prefix}-area`).setAttribute('points', area);
}

async function loadPerformanceSpecs() {
  if (perf.specsLoaded || !window.amaralBoost?.getPerformanceSpecs) return;
  try {
    const specs = await window.amaralBoost.getPerformanceSpecs();
    perf.specsLoaded = true;
    perf.cpuSpecBase = [specs.cpuModel, specs.cpuCores && specs.cpuThreads ? `${specs.cpuCores} núcleos / ${specs.cpuThreads} threads` : null].filter(Boolean).join(' · ');
    const memParts = [specs.memType, specs.memSpeed ? `${specs.memSpeed} MT/s` : null, (specs.memSlotsUsed && specs.memSlotsTotal) ? `${specs.memSlotsUsed}/${specs.memSlotsTotal} slots` : null].filter(Boolean);
    document.querySelector('#perf-mem-spec').textContent = memParts.join(' · ') || 'Não foi possível ler';
    const diskParts = [specs.diskMediaType, specs.diskBusType, specs.diskLabel].filter(Boolean);
    document.querySelector('#perf-disk-spec').textContent = diskParts.join(' · ') || 'Não foi possível ler';
    document.querySelector('#perf-gpu-spec').textContent = specs.gpuName || 'Não foi possível ler';
    document.querySelector('#perf-net-spec').textContent = specs.netAdapterName || 'Sem adaptador conectado identificado';
  } catch { /* mantém "Lendo…"; tenta de novo na próxima vez que a tela abrir */ }
}

function renderPerformanceLive(live) {
  const status = document.querySelector('#performance-status'); if (status) status.textContent = 'Leitura local, atualizada a cada poucos segundos';

  pushPerfHistory('cpu', live.cpuPercent);
  document.querySelector('#perf-cpu-value').textContent = typeof live.cpuPercent === 'number' ? `${live.cpuPercent}%` : 'Não disponível';
  document.querySelector('#perf-cpu-spec').textContent = [perf.cpuSpecBase, typeof live.cpuGHz === 'number' ? `${live.cpuGHz.toFixed(2)} GHz` : null].filter(Boolean).join(' · ') || 'Não foi possível ler';
  renderPerfChart('cpu', 'cpu', 100);

  pushPerfHistory('mem', live.memPercent);
  document.querySelector('#perf-mem-value').textContent = (typeof live.memUsedGB === 'number' && typeof live.memTotalGB === 'number')
    ? `${live.memUsedGB.toFixed(1)} / ${live.memTotalGB.toFixed(1)} GB${typeof live.memPercent === 'number' ? ` (${live.memPercent}%)` : ''}`
    : 'Não disponível';
  renderPerfChart('mem', 'mem', 100);

  pushPerfHistory('gpu', live.gpuPercent);
  document.querySelector('#perf-gpu-value').textContent = typeof live.gpuPercent === 'number' ? `${live.gpuPercent}%` : 'Não disponível';
  document.querySelector('#perf-gpu-detail').textContent = typeof live.vramGB === 'number' ? `VRAM em uso ${live.vramGB.toFixed(1)} GB` : '';
  renderPerfChart('gpu', 'gpu', 100);

  pushPerfHistory('disk', live.diskPercent);
  document.querySelector('#perf-disk-value').textContent = typeof live.diskPercent === 'number' ? `${live.diskPercent}%` : 'Não disponível';
  renderPerfChart('disk', 'disk', 100);

  pushPerfHistory('net', live.netDownMBs);
  document.querySelector('#perf-net-value').textContent = typeof live.netDownMBs === 'number' ? `↓ ${live.netDownMBs.toFixed(1)} MB/s` : 'Não disponível';
  document.querySelector('#perf-net-detail').textContent = typeof live.netUpMBs === 'number' ? `↑ ${live.netUpMBs.toFixed(1)} MB/s` : '';
  renderPerfChart('net', 'net');
}

async function pollPerformanceOnce() {
  if (!perf.active || !window.amaralBoost?.getPerformanceLive) return;
  try {
    const live = await window.amaralBoost.getPerformanceLive();
    if (perf.active) renderPerformanceLive(live);
  } catch {
    const status = document.querySelector('#performance-status'); if (status) status.textContent = 'Não foi possível concluir a leitura local';
  } finally {
    if (perf.active) perf.timerId = setTimeout(pollPerformanceOnce, PERF_POLL_MS);
  }
}

function startPerformancePolling() {
  if (perf.active) return;
  perf.active = true;
  loadPerformanceSpecs();
  pollPerformanceOnce();
}

function stopPerformancePolling() {
  perf.active = false;
  clearTimeout(perf.timerId);
  perf.timerId = null;
}
// ---------- Gerenciamento de RAM: leitura (navegadores + top processos) e o limite avançado ----------
const RAM_POLL_MS = 4000;
const ram = { timerId: null, active: false, data: null, draftLimitMB: 8192, sliderInitialized: false };

function formatGB(mb) { return typeof mb === 'number' ? (mb / 1024).toFixed(1) : '—'; }

function ramRow(label, mb, count) {
  const row = document.createElement('div'); row.className = 'ram-row';
  const name = document.createElement('span'); name.className = 'ram-row-name'; name.textContent = count > 1 ? `${label} (${count})` : label;
  const value = document.createElement('span'); value.className = 'ram-row-value'; value.textContent = typeof mb === 'number' ? `${formatGB(mb)} GB` : 'Não disponível';
  row.append(name, value);
  return row;
}

function renderRamBrowsersList(browsers) {
  const list = document.querySelector('#ram-browsers-list'); list.replaceChildren();
  if (!browsers || !browsers.length) { list.innerHTML = '<p class="muted">Nenhum navegador reconhecido está aberto agora.</p>'; return; }
  browsers.slice().sort((a, b) => (b.mb || 0) - (a.mb || 0)).forEach(browser => list.append(ramRow(browser.label, browser.mb, browser.count)));
}

function renderRamTopProcesses(topProcesses) {
  const list = document.querySelector('#ram-top-processes'); list.replaceChildren();
  if (!topProcesses || !topProcesses.length) { list.innerHTML = '<p class="muted">Não foi possível ler os processos do sistema.</p>'; return; }
  topProcesses.forEach(item => list.append(ramRow(item.name, item.mb, item.count)));
}

function ramButtonLabel(data) {
  if (!data.enabled) return 'Ativar limite';
  return data.running ? 'Desativar limite' : 'Retomar proteção';
}

function renderRamState(data) {
  ram.data = data;
  const status = document.querySelector('#ram-status');
  const toggle = document.querySelector('#ram-limit-toggle');
  if (!data || !data.supported) { status.textContent = 'Disponível somente no Windows'; toggle.disabled = true; return; }

  document.querySelector('#ram-browsers-total').textContent = typeof data.browsersUsageMB === 'number' ? `${formatGB(data.browsersUsageMB)} GB · ${data.browsersRunningCount} processo(s)` : 'Não disponível';
  renderRamBrowsersList(data.browsersBreakdown);
  renderRamTopProcesses(data.topProcesses);
  document.querySelector('#ram-recognized-list').textContent = data.recognizedBrowsers.map(browser => browser.label).join(', ');

  const slider = document.querySelector('#ram-limit-slider');
  const number = document.querySelector('#ram-limit-number');
  if (!ram.sliderInitialized) {
    const totalGB = data.totalMemMB / 1024, maxGB = data.maxLimitMB / 1024, minGB = data.minLimitMB / 1024;
    slider.min = number.min = minGB; slider.max = number.max = maxGB.toFixed(1); slider.step = number.step = '0.5';
    const initialMB = data.limitMB || Math.min(8192, data.maxLimitMB);
    ram.draftLimitMB = initialMB;
    slider.value = number.value = (initialMB / 1024).toFixed(1);
    document.querySelector('#ram-limit-range-hint').textContent = `Entre ${minGB.toFixed(1)} GB e ${maxGB.toFixed(1)} GB (RAM total do PC: ${totalGB.toFixed(1)} GB).`;
    ram.sliderInitialized = true;
  }

  toggle.disabled = false;
  toggle.textContent = ramButtonLabel(data);
  status.textContent = !data.enabled ? 'Desativado'
    : data.running ? `Ativo desde ${formatHistoryTimestamp(data.enabledAt)} · teto de ${formatGB(data.limitMB)} GB`
    : 'Ativado, mas a proteção não está rodando agora — reative para retomar';
}

async function pollRamOnce() {
  if (!ram.active || !window.amaralBoost?.getRamLimitState) return;
  try {
    const data = await window.amaralBoost.getRamLimitState();
    if (ram.active) renderRamState(data);
  } catch {
    const status = document.querySelector('#ram-status'); if (status) status.textContent = 'Não foi possível concluir a leitura local';
  } finally {
    if (ram.active) ram.timerId = setTimeout(pollRamOnce, RAM_POLL_MS);
  }
}

function startRamPolling() { if (ram.active) return; ram.active = true; pollRamOnce(); }
function stopRamPolling() { ram.active = false; clearTimeout(ram.timerId); ram.timerId = null; }

// ---------- Inicialização: entradas do Registro e das pastas Inicializar ----------
const startup = { loading: false, apps: [] };

function startupIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/><path d="M5 19.5h14"/></svg>';
}

function renderStartupApps(data) {
  const list = document.querySelector('#startup-list');
  const status = document.querySelector('#startup-status');
  list.replaceChildren();
  if (!data?.supported) {
    status.textContent = 'Disponível somente no Windows';
    list.innerHTML = '<p class="startup-empty">A lista de inicialização está disponível somente quando o Amaral Boost roda no Windows.</p>';
    return;
  }
  startup.apps = data.apps || [];
  const enabledCount = startup.apps.filter(app => app.enabled).length;
  status.textContent = startup.apps.length ? `${enabledCount} de ${startup.apps.length} ativado(s)` : 'Nenhum app encontrado';
  if (!startup.apps.length) {
    list.innerHTML = '<p class="startup-empty">Nenhum app foi encontrado nas entradas de inicialização do Registro ou nas pastas Inicializar.</p>';
    return;
  }
  startup.apps.forEach(app => {
    const row = document.createElement('article'); row.className = 'startup-row';
    const icon = document.createElement('span'); icon.className = 'startup-app-icon'; icon.innerHTML = startupIcon();
    const info = document.createElement('div'); info.className = 'startup-app-info';
    const name = document.createElement('strong'); name.className = 'startup-app-name'; name.textContent = app.name;
    const command = document.createElement('span'); command.className = 'startup-app-meta'; command.textContent = app.command;
    const location = document.createElement('span'); location.className = 'startup-app-location'; location.textContent = app.location;
    info.append(name, command, location);
    const label = document.createElement('label'); label.className = 'switch'; label.title = app.enabled ? 'Desativar na inicialização' : 'Ativar na inicialização';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = Boolean(app.enabled); toggle.setAttribute('aria-label', `${app.enabled ? 'Desativar' : 'Ativar'} ${app.name} na inicialização`);
    const track = document.createElement('span');
    label.append(toggle, track);
    toggle.addEventListener('change', () => setStartupEnabled(app, toggle, label));
    row.append(icon, info, label);
    list.append(row);
  });
}

async function loadStartupApps() {
  if (startup.loading || !window.amaralBoost?.getStartupApps) return;
  startup.loading = true;
  const status = document.querySelector('#startup-status');
  status.textContent = 'Lendo…';
  try {
    renderStartupApps(await window.amaralBoost.getStartupApps());
  } catch {
    status.textContent = 'Não foi possível ler a inicialização';
    document.querySelector('#startup-list').innerHTML = '<p class="startup-empty">Não foi possível obter as entradas de inicialização agora.</p>';
  } finally {
    startup.loading = false;
  }
}

async function setStartupEnabled(app, toggle, label) {
  if (!window.amaralBoost?.setStartupAppEnabled) return;
  const enabled = toggle.checked;
  toggle.disabled = true;
  label.title = 'Aplicando…';
  try {
    const result = await window.amaralBoost.setStartupAppEnabled({ kind: app.kind, source: app.source, name: app.name }, enabled);
    if (!result.ok) throw new Error(result.message);
    if (result.historyEntry) { state.history.unshift(result.historyEntry); renderHistory(); }
    showToast(result.message);
    await loadStartupApps();
  } catch (error) {
    toggle.checked = !enabled;
    toggle.disabled = false;
    label.title = !enabled ? 'Desativar na inicialização' : 'Ativar na inicialização';
    showToast(error?.message || 'Não foi possível alterar este app.');
  }
}

// ---------- Armazenamento: instalações registradas maiores que 10 GB ----------
const storage = { loadingDrives: false, scanning: false, drivesLoaded: false, drives: [] };

function formatStorageSize(bytes) {
  return typeof bytes === 'number' && bytes >= 0 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '—';
}

function storageIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/><path d="M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/></svg>';
}

function resetStorageResults(message) {
  document.querySelector('#storage-list').innerHTML = `<p class="startup-empty">${message}</p>`;
}

function renderStorageDrives(data) {
  const status = document.querySelector('#storage-status');
  const select = document.querySelector('#storage-drive');
  const detail = document.querySelector('#storage-drive-detail');
  const scanButton = document.querySelector('#storage-scan');
  if (!data?.supported) {
    status.textContent = 'Disponível somente no Windows';
    detail.textContent = 'A leitura de unidades não está disponível neste sistema.';
    select.disabled = true; scanButton.disabled = true;
    return;
  }
  storage.drives = data.drives || [];
  select.replaceChildren();
  if (!storage.drives.length) {
    status.textContent = 'Nenhuma unidade encontrada';
    detail.textContent = 'Não foi possível identificar unidades locais.';
    select.disabled = true; scanButton.disabled = true;
    return;
  }
  storage.drives.forEach(drive => {
    const option = document.createElement('option'); option.value = drive.letter;
    option.textContent = `${drive.letter} — ${drive.label} (${formatStorageSize(drive.freeBytes)} livres)`;
    select.append(option);
  });
  const selected = storage.drives[0];
  detail.textContent = `${selected.label} · ${formatStorageSize(selected.freeBytes)} livres de ${formatStorageSize(selected.totalBytes)}.`;
  status.textContent = 'Pronto para verificar';
  select.disabled = false; scanButton.disabled = false;
}

async function loadStorageDrives() {
  if (storage.loadingDrives || storage.drivesLoaded || !window.amaralBoost?.getStorageDrives) return;
  storage.loadingDrives = true;
  try {
    renderStorageDrives(await window.amaralBoost.getStorageDrives());
    storage.drivesLoaded = true;
  } catch {
    document.querySelector('#storage-status').textContent = 'Não foi possível ler as unidades';
    document.querySelector('#storage-drive-detail').textContent = 'Tente abrir a tela novamente.';
    resetStorageResults('Não foi possível obter as unidades locais agora.');
  } finally {
    storage.loadingDrives = false;
  }
}

function updateSelectedStorageDrive() {
  const selected = storage.drives.find(drive => drive.letter === document.querySelector('#storage-drive').value);
  if (!selected) return;
  document.querySelector('#storage-drive-detail').textContent = `${selected.label} · ${formatStorageSize(selected.freeBytes)} livres de ${formatStorageSize(selected.totalBytes)}.`;
  document.querySelector('#storage-status').textContent = 'Pronto para verificar';
  resetStorageResults('Clique em “Verificar armazenamento” para procurar apps maiores que 10 GB nesta unidade.');
}

function renderStorageApps(result) {
  const list = document.querySelector('#storage-list');
  const status = document.querySelector('#storage-status');
  list.replaceChildren();
  if (!result?.supported) {
    status.textContent = 'Disponível somente no Windows';
    resetStorageResults('A análise de armazenamento está disponível somente no Windows.');
    return;
  }
  if (result.error) {
    status.textContent = result.error;
    resetStorageResults(result.error);
    return;
  }
  const apps = result.apps || [];
  status.textContent = apps.length ? `${apps.length} app(s) acima de 10 GB` : 'Nenhum app acima de 10 GB';
  if (!apps.length) {
    resetStorageResults(`Foram verificadas ${result.scannedApps || 0} instalação(ões) registradas em ${result.drive}. Nenhuma passou de 10 GB.`);
    return;
  }
  apps.forEach(app => {
    const row = document.createElement('article'); row.className = 'storage-row';
    const icon = document.createElement('span'); icon.className = 'storage-app-icon'; icon.innerHTML = storageIcon();
    const info = document.createElement('div'); info.className = 'storage-app-info';
    const name = document.createElement('strong'); name.className = 'storage-app-name'; name.textContent = app.name;
    const installPath = document.createElement('span'); installPath.className = 'storage-app-path'; installPath.textContent = app.installPath;
    const publisher = document.createElement('span'); publisher.className = 'storage-app-publisher'; publisher.textContent = app.publisher || 'Fornecedor não informado';
    const size = document.createElement('strong'); size.className = 'storage-app-size'; size.textContent = formatStorageSize(app.sizeBytes);
    info.append(name, installPath, publisher);
    row.append(icon, info, size);
    list.append(row);
  });
}

async function scanStorageApps() {
  if (storage.scanning || !window.amaralBoost?.scanStorageApps) return;
  const drive = document.querySelector('#storage-drive').value;
  if (!drive) return;
  storage.scanning = true;
  const status = document.querySelector('#storage-status');
  const select = document.querySelector('#storage-drive');
  const scanButton = document.querySelector('#storage-scan');
  status.textContent = `Verificando instalações em ${drive}…`;
  select.disabled = true; scanButton.disabled = true; scanButton.textContent = 'Verificando…';
  resetStorageResults('A leitura pode levar alguns instantes em unidades com muitos apps.');
  try {
    renderStorageApps(await window.amaralBoost.scanStorageApps(drive));
  } catch {
    status.textContent = 'Não foi possível concluir a verificação';
    resetStorageResults('Não foi possível analisar as instalações nesta unidade.');
  } finally {
    storage.scanning = false;
    select.disabled = false; scanButton.disabled = false; scanButton.textContent = 'Verificar armazenamento';
  }
}

function openRamEnableReview() {
  if (!ram.data) return;
  const gb = formatGB(ram.draftLimitMB);
  state.reviewMode = 'ram-enable';
  document.querySelector('#modal-title').textContent = `Ativar limite de ${gb} GB para navegadores`;
  document.querySelector('#modal-description').textContent = 'Cria uma tarefa do Windows em segundo plano que passa a limitar a soma de memória de todos os navegadores reconhecidos.';
  applyButton.textContent = 'Ativar limite'; applyButton.disabled = false;
  reviewList.replaceChildren(
    reviewItem(`Teto combinado: ${gb} GB (RAM total do PC: ${formatGB(ram.data.totalMemMB)} GB).`),
    reviewItem(`Navegadores reconhecidos: ${ram.data.recognizedBrowsers.map(browser => browser.label).join(', ')}.`),
    reviewItem('Ao bater no teto, o navegador pode fechar uma aba ou travar — é assim que um limite de memória por processo do Windows funciona.'),
    reviewItem('Continua ativo mesmo se você fechar o Amaral Boost completamente, mas não sobrevive a reiniciar o Windows.')
  );
  modal.hidden = false;
}

function openRamDisableReview() {
  state.reviewMode = 'ram-disable';
  document.querySelector('#modal-title').textContent = 'Desativar limite de RAM';
  document.querySelector('#modal-description').textContent = 'A partir de agora, nenhum processo novo de navegador entra no limite.';
  applyButton.textContent = 'Desativar limite'; applyButton.disabled = false;
  reviewList.replaceChildren(reviewItem('Navegadores que já estão dentro do limite continuam limitados até serem fechados — o Windows não permite soltar um processo de um limite já aplicado.', 'failed'));
  modal.hidden = false;
}

async function applyRamEnable() {
  if (!window.amaralBoost?.enableRamLimit) return showToast('Limite de RAM indisponível.');
  applyButton.disabled = true; applyButton.textContent = 'Ativando…';
  try {
    const result = await window.amaralBoost.enableRamLimit(ram.draftLimitMB);
    if (result.historyEntry) state.history.unshift(result.historyEntry);
    renderHistory(); if (result.state) renderRamState(result.state); closeReview();
    showToast(result.ok ? result.message : `Não foi possível concluir: ${result.message}`);
  } catch {
    closeReview(); showToast('Não foi possível ativar o limite.');
  }
}

async function applyRamDisable() {
  if (!window.amaralBoost?.disableRamLimit) return showToast('Limite de RAM indisponível.');
  applyButton.disabled = true; applyButton.textContent = 'Desativando…';
  try {
    const result = await window.amaralBoost.disableRamLimit();
    if (result.historyEntry) state.history.unshift(result.historyEntry);
    renderHistory(); if (result.state) renderRamState(result.state); closeReview();
    showToast(result.message);
  } catch {
    closeReview(); showToast('Não foi possível desativar o limite.');
  }
}

function reviewItem(text, tone = '') { const item = document.createElement('div'); item.className = `review-item ${tone}`; const icon = document.createElement('span'); icon.textContent = tone === 'failed' ? '!' : '✓'; item.append(icon, document.createTextNode(text)); return item; }
function updateProfileCards() { document.querySelectorAll('.profile').forEach(button => { const selected = button.dataset.profile === state.selectedProfile; button.classList.toggle('active-profile', selected); if (selected) button.querySelector('small').textContent = 'Perfil selecionado'; }); }
function renderProfilePreview(openModal = false) { const profile = profiles[state.selectedProfile]; document.querySelector('#profile-detail-title').textContent = state.selectedProfile; document.querySelector('#profile-detail').textContent = profile.description; document.querySelector('#profile-effects').replaceChildren(...effectsFor(state.selectedProfile).map(effect => { const item = document.createElement('li'); item.textContent = effect; return item; })); updateProfileCards(); if (openModal) openReview(); }
function snapshotGameModeText(snapshot) { if (!snapshot.gameMode.exists) return 'remover o valor do usuário (não definido originalmente)'; return snapshot.gameMode.value === 1 ? 'ativar' : 'desativar'; }

async function openReview() {
  state.reviewMode = 'profile';
  const isRestore = state.selectedProfile === 'Padrão Windows';
  document.querySelector('#modal-title').textContent = isRestore ? 'Restaurar estado pré-Amaral' : `Aplicar perfil ${state.selectedProfile}`;
  document.querySelector('#modal-description').textContent = isRestore ? 'O perfil Padrão Windows restaura o snapshot salvo antes da primeira alteração feita pelo Amaral Boost e reverte qualquer ajuste individual que ainda esteja aplicado.' : 'Ao aplicar, o Amaral Boost salva o estado original uma única vez e altera os itens abaixo. Um item bloqueado (ex.: exige administrador) não impede os demais.';
  applyButton.textContent = isRestore ? 'Restaurar configuração original' : 'Aplicar perfil'; applyButton.disabled = false; reviewList.replaceChildren();
  if (isRestore) {
    const snapshot = state.profileState?.snapshot;
    const appliedIds = Object.keys(state.tweaksState.applied || {});
    if (snapshot) reviewList.append(reviewItem(`Plano de energia: restaurar o GUID salvo ${snapshot.powerPlanGuid}.`), reviewItem(`Game Mode: ${snapshotGameModeText(snapshot)} conforme o estado salvo.`));
    else reviewList.append(reviewItem('Snapshot de perfil pré-Amaral não encontrado: plano de energia e Game Mode não serão alterados.', appliedIds.length ? '' : 'failed'));
    if (appliedIds.length) {
      const names = appliedIds.map(id => state.tweaksCatalog.tweaks.find(item => item.id === id)?.name || id);
      reviewList.append(reviewItem(`Ajustes individuais: reverter ${names.join(', ')}.`));
    } else if (!snapshot) {
      reviewList.append(reviewItem('Nenhum ajuste individual aplicado no momento.'));
    }
    if (!snapshot && !appliedIds.length) applyButton.disabled = true;
  } else effectsFor(state.selectedProfile).forEach(effect => reviewList.append(reviewItem(effect)));
  modal.hidden = false;
}
function closeReview() { modal.hidden = true; }

function openTweakReview(tweakId) {
  const tweak = state.tweaksCatalog.tweaks.find(item => item.id === tweakId);
  if (!tweak) return;
  const applied = Boolean(state.tweaksState.applied[tweakId]);
  const blockedByAdmin = tweak.admin && !state.tweaksState.admin && !applied;
  state.reviewMode = 'tweak'; state.pendingTweakId = tweakId; state.pendingTweakAction = applied ? 'revert' : 'apply';
  document.querySelector('#modal-title').textContent = applied ? `Reverter: ${tweak.name}` : `Aplicar: ${tweak.name}`;
  document.querySelector('#modal-description').textContent = applied
    ? 'Isso restaura exatamente o valor que estava salvo antes deste ajuste ser aplicado.'
    : 'O Amaral Boost guarda o valor atual antes de mudar, para poder reverter exatamente depois.';
  applyButton.textContent = applied ? 'Reverter ajuste' : 'Aplicar ajuste'; applyButton.disabled = false;
  reviewList.replaceChildren(reviewItem(tweak.desc));
  if (tweak.notWhen) reviewList.append(reviewItem(`Não use se ${tweak.notWhen}`));
  if (blockedByAdmin) { reviewList.append(reviewItem('Exige abrir o Amaral Boost como administrador.', 'failed')); applyButton.disabled = true; }
  modal.hidden = false;
}

function openCleanupReview(cleanupId) {
  const cleanup = state.tweaksCatalog.cleanups.find(item => item.id === cleanupId);
  if (!cleanup) return;
  state.reviewMode = 'cleanup'; state.pendingTweakId = cleanupId;
  document.querySelector('#modal-title').textContent = `Executar: ${cleanup.name}`;
  document.querySelector('#modal-description').textContent = 'Ação de uma vez só: não fica um estado salvo para desfazer depois.';
  applyButton.textContent = 'Executar'; applyButton.disabled = false;
  reviewList.replaceChildren(reviewItem(cleanup.desc));
  modal.hidden = false;
}
async function refreshProfileState() { const status = document.querySelector('#profile-status'); if (!window.amaralBoost?.getProfileState) { status.textContent = 'Controle de perfis indisponível'; return; } try { state.profileState = await window.amaralBoost.getProfileState(); const prefix = state.currentProfile ? `Perfil atual nesta sessão: ${state.currentProfile} · ` : ''; status.textContent = prefix + (state.profileState.snapshot ? 'Snapshot pré-Amaral protegido localmente' : 'Snapshot será criado na primeira aplicação'); } catch { state.profileState = null; status.textContent = 'Não foi possível ler o estado dos perfis'; } }

function formatHistoryTimestamp(iso) {
  try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return 'Data indisponível'; }
}

function historyTitle(entry) {
  if (entry.kind === 'tweak') return `Ajuste: ${entry.label}`;
  if (entry.kind === 'cleanup') return `Limpeza: ${entry.label}`;
  if (entry.kind === 'ram-limit') return entry.label;
  if (entry.kind === 'startup') return entry.label;
  return `Perfil: ${entry.profile || entry.label}`;
}

function renderHistory() {
  const timeline = document.querySelector('#timeline'); timeline.replaceChildren();
  if (!state.history.length) { timeline.innerHTML = '<div class="timeline-empty"><span>✓</span><h3>Nenhuma ação aplicada</h3><p>Aplicações e restaurações aparecerão aqui com o resultado de cada ajuste.</p></div>'; return; }
  state.history.forEach(entry => {
    const item = document.createElement('article'); item.className = 'history-item';
    const header = document.createElement('div'); header.className = 'history-item-header';
    const title = document.createElement('strong'); title.textContent = historyTitle(entry);
    const time = document.createElement('time'); time.textContent = formatHistoryTimestamp(entry.appliedAt); if (entry.appliedAt) time.dateTime = entry.appliedAt;
    header.append(title, time);
    const summary = document.createElement('p'); summary.textContent = entry.applied ? 'Concluído.' : 'Concluído com pendências; veja os itens abaixo.';
    item.append(header, summary);
    entry.results.forEach(result => { const line = document.createElement('p'); line.className = `history-result ${result.status}`; line.textContent = `${result.setting}: ${result.message}`; item.append(line); });
    timeline.append(item);
  });
}

async function loadHistory() {
  if (!window.amaralBoost?.getHistory) return;
  try { state.history = await window.amaralBoost.getHistory(); renderHistory(); } catch { /* mantém o histórico já carregado */ }
}

function renderTweaks() {
  const grid = document.querySelector('#tweaks-grid'); grid.replaceChildren();
  state.tweaksCatalog.tweaks.forEach(tweak => {
    const applied = Boolean(state.tweaksState.applied[tweak.id]);
    const blockedByAdmin = tweak.admin && !state.tweaksState.admin && !applied;
    const card = document.createElement('article'); card.className = `tweak-card${applied ? ' tweak-applied' : ''}`;
    const head = document.createElement('div'); head.className = 'tweak-head';
    const name = document.createElement('strong'); name.textContent = tweak.name;
    const badge = document.createElement('span'); badge.className = `tweak-badge${applied ? ' on' : ''}`; badge.textContent = applied ? 'Aplicado' : (blockedByAdmin ? 'Exige admin' : 'Não aplicado');
    head.append(name, badge);
    const desc = document.createElement('p'); desc.textContent = tweak.desc;
    card.append(head, desc);
    if (tweak.notWhen) { const note = document.createElement('p'); note.className = 'tweak-notwhen'; note.textContent = `Não use se ${tweak.notWhen}`; card.append(note); }
    const button = document.createElement('button'); button.type = 'button'; button.className = applied ? 'secondary-button' : 'primary-button small';
    button.textContent = applied ? 'Reverter' : 'Aplicar'; button.disabled = blockedByAdmin;
    button.addEventListener('click', () => openTweakReview(tweak.id));
    card.append(button);
    grid.append(card);
  });
  const adminStatus = document.querySelector('#tweaks-admin-status');
  adminStatus.textContent = state.tweaksState.admin ? 'Executando como administrador' : 'Ajustes marcados "Exige admin" precisam do Amaral Boost aberto como administrador';
}

function renderCleanups() {
  const grid = document.querySelector('#cleanups-grid'); grid.replaceChildren();
  state.tweaksCatalog.cleanups.forEach(cleanup => {
    const card = document.createElement('article'); card.className = 'tweak-card';
    const head = document.createElement('div'); head.className = 'tweak-head';
    const name = document.createElement('strong'); name.textContent = cleanup.name;
    head.append(name);
    const desc = document.createElement('p'); desc.textContent = cleanup.desc;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button';
    button.textContent = 'Executar'; button.addEventListener('click', () => openCleanupReview(cleanup.id));
    card.append(head, desc, button);
    grid.append(card);
  });
}

async function loadTweaksCatalog() {
  if (!window.amaralBoost?.getTweaksCatalog) return;
  try { state.tweaksCatalog = await window.amaralBoost.getTweaksCatalog(); renderTweaks(); renderCleanups(); } catch { /* mantém o catálogo já carregado */ }
}

async function loadTweaksState() {
  if (!window.amaralBoost?.getTweaksState) return;
  try { state.tweaksState = await window.amaralBoost.getTweaksState(); renderTweaks(); } catch { /* mantém o estado já carregado */ }
}

async function applyOrRevertSelectedTweak() {
  const id = state.pendingTweakId; const action = state.pendingTweakAction;
  const method = action === 'revert' ? window.amaralBoost?.revertTweak : window.amaralBoost?.applyTweak;
  if (!method) return showToast('Ajustes individuais indisponíveis.');
  applyButton.disabled = true; applyButton.textContent = action === 'revert' ? 'Revertendo…' : 'Aplicando…';
  try {
    const result = await method(id);
    if (result.historyEntry) state.history.unshift(result.historyEntry);
    renderHistory(); await loadTweaksState(); closeReview();
    showToast(result.ok ? result.message : `Não foi possível concluir: ${result.message}`);
  } catch {
    closeReview(); showToast('Não foi possível concluir esta ação.');
  }
}

async function runSelectedCleanup() {
  const id = state.pendingTweakId;
  if (!window.amaralBoost?.runCleanup) return showToast('Limpeza indisponível.');
  applyButton.disabled = true; applyButton.textContent = 'Executando…';
  try {
    const result = await window.amaralBoost.runCleanup(id);
    if (result.historyEntry) state.history.unshift(result.historyEntry);
    renderHistory(); closeReview();
    showToast(result.ok ? result.message : `Não foi possível concluir: ${result.message}`);
  } catch {
    closeReview(); showToast('Não foi possível concluir esta limpeza.');
  }
}

async function handleApplyButtonClick() {
  if (state.reviewMode === 'tweak') return applyOrRevertSelectedTweak();
  if (state.reviewMode === 'cleanup') return runSelectedCleanup();
  if (state.reviewMode === 'ram-enable') return applyRamEnable();
  if (state.reviewMode === 'ram-disable') return applyRamDisable();
  return applySelectedProfile();
}

async function applySelectedProfile() {
  if (!window.amaralBoost?.applyProfile) return showToast('Aplicação de perfil indisponível.');
  applyButton.disabled = true; applyButton.textContent = 'Aplicando…';
  try {
    const result = await window.amaralBoost.applyProfile(state.selectedProfile);
    if (result.applied) state.currentProfile = result.profile;
    if (result.historyEntry) state.history.unshift(result.historyEntry);
    renderHistory(); await refreshProfileState(); closeReview();
    showToast(result.applied ? `${result.profile} aplicado com segurança.` : 'Perfil aplicado parcialmente ou bloqueado; consulte a atividade.');
  } catch {
    state.history.unshift({ profile: state.selectedProfile, applied: false, appliedAt: new Date().toISOString(), results: [{ setting: 'Aplicação', status: 'failed', message: 'O perfil não pôde ser aplicado.' }] });
    renderHistory(); closeReview(); showToast('Não foi possível aplicar o perfil. Nenhuma outra ação foi tentada.');
  }
}

// ---------- Atualizações: verifica os Releases do GitHub ao abrir o app, e também sob demanda ----------
const updates = { checked: false, checking: false };

function renderUpdatesResult(result) {
  const status = document.querySelector('#updates-status');
  const badge = document.querySelector('#updates-badge');
  const currentEl = document.querySelector('#updates-current-version');
  const latestEl = document.querySelector('#updates-latest-version');
  const notesEl = document.querySelector('#updates-notes');
  const downloadButton = document.querySelector('#updates-download');

  currentEl.textContent = result.currentVersion ? `v${result.currentVersion}` : '—';

  // Se o usuário já está com a aba de Atualizações aberta, a página em si já
  // conta a novidade — a bolinha só faz sentido pra chamar atenção de fora.
  const onUpdatesView = document.querySelector('.nav-item.active')?.dataset.view === 'updates';
  const dot = document.querySelector('#updates-nav-dot');

  if (!result.ok) {
    status.textContent = result.error || 'Não foi possível verificar agora';
    badge.textContent = 'Erro na verificação';
    badge.className = 'tweak-badge';
    latestEl.textContent = '—';
    notesEl.hidden = true;
    downloadButton.hidden = true;
    return;
  }

  latestEl.textContent = `v${result.latestVersion}`;
  if (result.hasUpdate) {
    status.textContent = result.publishedAt ? `Publicada em ${formatHistoryTimestamp(result.publishedAt)}` : 'Nova versão disponível';
    badge.textContent = 'Atualização disponível';
    badge.className = 'tweak-badge on';
    downloadButton.hidden = false;
    downloadButton.dataset.url = result.releaseUrl;
    if (dot) dot.hidden = onUpdatesView;
  } else {
    status.textContent = 'Você está na versão mais recente';
    badge.textContent = 'Atualizado';
    badge.className = 'tweak-badge on';
    downloadButton.hidden = true;
    if (dot) dot.hidden = true;
  }
  if (result.releaseNotes && result.releaseNotes.trim()) { notesEl.textContent = result.releaseNotes.trim(); notesEl.hidden = false; }
  else notesEl.hidden = true;
}

async function checkForUpdates() {
  if (updates.checking || !window.amaralBoost?.checkForUpdates) return;
  updates.checking = true; updates.checked = true;
  const status = document.querySelector('#updates-status');
  const checkButton = document.querySelector('#updates-check-now');
  status.textContent = 'Verificando…';
  checkButton.disabled = true; checkButton.textContent = 'Verificando…';
  try {
    const result = await window.amaralBoost.checkForUpdates();
    renderUpdatesResult(result);
  } catch {
    renderUpdatesResult({ ok: false, currentVersion: document.querySelector('#version').textContent, error: 'Não foi possível verificar agora' });
  } finally {
    updates.checking = false;
    checkButton.disabled = false; checkButton.textContent = 'Verificar agora';
  }
}

document.querySelector('#updates-check-now').addEventListener('click', checkForUpdates);
document.querySelector('#updates-download').addEventListener('click', async event => {
  const url = event.currentTarget.dataset.url;
  if (!url || !window.amaralBoost?.openExternal) return;
  try { await window.amaralBoost.openExternal(url); } catch { showToast('Não foi possível abrir o link de download.'); }
});

document.querySelector('#copy-pix-key').addEventListener('click', async () => {
  const key = document.querySelector('#pix-key').textContent.trim();
  try {
    if (window.amaralBoost?.copyText) await window.amaralBoost.copyText(key);
    else await navigator.clipboard.writeText(key);
    showToast('Chave Pix copiada.');
  } catch {
    showToast('Não foi possível copiar automaticamente. Selecione e copie a chave manualmente.');
  }
});
document.querySelector('#donate-github').addEventListener('click', async () => {
  const url = 'https://github.com/Amaralbit/AmaralBoost';
  if (!window.amaralBoost?.openExternal) return;
  try { await window.amaralBoost.openExternal(url); } catch { showToast('Não foi possível abrir o link do GitHub.'); }
});

// Enquanto o app fica em segundo plano na bandeja, a janela existe mas fica oculta:
// pausa o monitor pra não ficar chamando o PowerShell à toa, e retoma ao reabrir.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(perf.timerId); perf.timerId = null; clearTimeout(ram.timerId); ram.timerId = null; }
  else { if (perf.active && !perf.timerId) pollPerformanceOnce(); if (ram.active && !ram.timerId) pollRamOnce(); }
});

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('.category').forEach(button => button.addEventListener('click', () => { const category = button.dataset.category; state.categories.has(category) ? state.categories.delete(category) : state.categories.add(category); button.classList.toggle('selected', state.categories.has(category)); button.querySelector('b').textContent = state.categories.has(category) ? '✓' : ''; }));
document.querySelector('#select-all').addEventListener('click', () => { state.categories = new Set(['Inicialização', 'Armazenamento', 'Privacidade', 'Jogos']); document.querySelectorAll('.category').forEach(element => { element.classList.add('selected'); element.querySelector('b').textContent = '✓'; }); showToast('Áreas selecionadas para revisão.'); });
document.querySelectorAll('.profile').forEach(button => button.addEventListener('click', () => { state.selectedProfile = button.dataset.profile; renderProfilePreview(true); }));
document.querySelector('#optimize-now').addEventListener('click', openReview);
document.querySelector('#close-modal').addEventListener('click', closeReview);
document.querySelector('#cancel-modal').addEventListener('click', closeReview);
applyButton.addEventListener('click', handleApplyButtonClick);
modal.addEventListener('click', event => { if (event.target === modal) closeReview(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) closeReview(); });
document.querySelector('#clear-history').addEventListener('click', async () => {
  if (!window.confirm('Apagar todo o histórico local? Essa ação não pode ser desfeita.')) return;
  try { await window.amaralBoost?.clearHistory?.(); } catch { /* segue limpando a visualização local mesmo se a persistência falhar */ }
  state.history = []; renderHistory(); showToast('Histórico local apagado.');
});
document.querySelector('#export-diagnostics').addEventListener('click', async () => {
  if (!window.amaralBoost?.exportDiagnostics) return showToast('Exportação de diagnóstico indisponível.');
  try {
    const result = await window.amaralBoost.exportDiagnostics();
    if (result.exported) showToast(`Diagnóstico exportado para ${result.filePath}`);
    else if (result.error) showToast(result.error);
    else showToast('Exportação cancelada.');
  } catch { showToast('Não foi possível exportar o diagnóstico.'); }
});
document.querySelector('#ram-limit-slider').addEventListener('input', event => { document.querySelector('#ram-limit-number').value = event.target.value; ram.draftLimitMB = Math.round(parseFloat(event.target.value) * 1024); });
document.querySelector('#ram-limit-number').addEventListener('input', event => { document.querySelector('#ram-limit-slider').value = event.target.value; ram.draftLimitMB = Math.round(parseFloat(event.target.value) * 1024); });
document.querySelector('#ram-limit-toggle').addEventListener('click', () => {
  if (!ram.data || !ram.data.supported) return;
  if (!ram.data.enabled || !ram.data.running) openRamEnableReview();
  else openRamDisableReview();
});
document.querySelector('#storage-drive').addEventListener('change', updateSelectedStorageDrive);
document.querySelector('#storage-scan').addEventListener('click', scanStorageApps);

(async () => {
  const versionEl = document.querySelector('#version');
  try { versionEl.textContent = await window.amaralBoost.getAppVersion(); } catch { /* mantém o texto padrão do HTML */ }
})();

function setReadout(valueId, detailId, value, detail) { const fallback = 'Não foi possível ler'; const valueNode = document.querySelector(valueId); valueNode.textContent = value || fallback; valueNode.title = value || fallback; document.querySelector(detailId).textContent = detail || 'Tente abrir novamente'; }
async function loadSystemInfo() { const source = document.querySelector('#system-source'); if (!window.amaralBoost?.getSystemInfo) { source.textContent = 'Leitura local indisponível'; return; } try { const info = await window.amaralBoost.getSystemInfo(); setReadout('#cpu-value', '#cpu-detail', info.cpu, 'Detectado localmente'); setReadout('#memory-value', '#memory-detail', info.memoryTotal, info.memoryAvailable ? `${info.memoryAvailable} disponível agora` : 'Disponibilidade não lida'); setReadout('#gpu-value', '#gpu-detail', info.gpu, 'Detectado localmente'); const version = [info.windowsVersion && `versão ${info.windowsVersion}`, info.windowsBuild && `build ${info.windowsBuild}`].filter(Boolean).join(' · '); setReadout('#windows-value', '#windows-detail', info.windows, version || 'Versão não lida'); source.textContent = info.source || 'Leitura local'; } catch { source.textContent = 'Não foi possível concluir a leitura local'; [['#cpu-value', '#cpu-detail'], ['#memory-value', '#memory-detail'], ['#gpu-value', '#gpu-detail'], ['#windows-value', '#windows-detail']].forEach(([value, detail]) => setReadout(value, detail)); } }

renderProfilePreview();
refreshProfileState();
loadSystemInfo();
loadHistory();
loadTweaksCatalog().then(loadTweaksState);
// Verifica atualização toda vez que o app abre do zero, sem esperar o usuário
// entrar na aba — a bolinha vermelha no menu chama atenção se houver novidade.
checkForUpdates();
