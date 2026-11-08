/*!
 * Smart Finder — lógica do aplicativo (Web Bluetooth + interface).
 *
 * COMO A BUSCA FUNCIONA (e por quê há dois modos)
 * ------------------------------------------------
 * A Web Bluetooth API foi desenhada para privacidade: um site NÃO pode listar
 * livremente todos os dispositivos ao redor. Existem dois caminhos reais:
 *
 *  1) Modo "scan" (navigator.bluetooth.requestLEScan): varredura contínua que
 *     entrega cada anúncio BLE com nome e RSSI. É um recurso experimental;
 *     no Chrome/Edge exige ativar chrome://flags/#enable-experimental-web-platform-features.
 *
 *  2) Modo "chooser" (navigator.bluetooth.requestDevice): o navegador abre o
 *     seletor NATIVO de dispositivos e o usuário escolhe um. Depois disso, se
 *     disponível, device.watchAdvertisements() entrega o RSSI em tempo real.
 *
 * O app usa o modo 1 quando existe e cai para o modo 2 quando não existe.
 * Nada é simulado: se o navegador não fornece um dado, a tela mostra "n/d".
 */
(function () {
  'use strict';

  const S = window.SmartSignal;
  const $ = (id) => document.getElementById(id);

  /* =====================================================================
   * Constantes
   * ===================================================================== */

  // Serviços GATT que o site pede permissão para acessar depois da escolha
  // no seletor (sem listar aqui, o navegador bloqueia a leitura deles).
  const COMMON_SERVICES = [
    'battery_service', 'device_information', 'generic_access',
    'heart_rate', 'immediate_alert', 'link_loss', 'tx_power',
  ];

  const STALE_AFTER_MS = 10000; // sem anúncio há mais que isso = "sem sinal recente"
  const RENDER_MIN_INTERVAL = 250; // limita a taxa de redesenho (anúncios chegam muito rápido)
  const SORT_INTERVAL = 2500; // reordena a lista no máximo a cada 2,5 s (evita "pular" na tela)
  const HISTORY_KEY = 'smartfinder.history.v1';
  const HISTORY_MAX = 30;
  const NO_SCAN_HINT_AFTER_MS = 15000;

  /* =====================================================================
   * Detecção de recursos do navegador
   * ===================================================================== */

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hasBT = 'bluetooth' in navigator;
  const caps = {
    secure: window.isSecureContext === true, // HTTPS ou localhost
    bluetooth: hasBT,
    leScan: hasBT && typeof navigator.bluetooth.requestLEScan === 'function',
    watch: typeof window.BluetoothDevice !== 'undefined' &&
      typeof window.BluetoothDevice.prototype.watchAdvertisements === 'function',
  };

  /* =====================================================================
   * Estado
   * ===================================================================== */

  const state = {
    mode: null, //            'scan' | 'chooser' | null
    started: false, //        já houve alguma busca?
    scanning: false, //       varredura contínua ligada
    chooserOpen: false, //    seletor nativo aberto
    scanHandle: null,
    devices: new Map(), //    id -> registro (ver upsert)
    selectedId: null,
    startedAt: 0,
    onlyNamed: false,
    sound: false,
    history: loadHistory(), // [{ id, name, rssi, lastSeen }]
    lastRender: 0,
    renderQueued: false,
    lastSort: 0,
    lastHistoryPersist: 0,
    historySig: '',
    order: [],
  };

  const seenEvents = new WeakSet(); // evita contar o mesmo anúncio duas vezes (evento "borbulha")
  const cardEls = new Map(); //        id -> <li> da lista
  const blipEls = new Map(); //        id -> <button> do radar

  /* =====================================================================
   * Utilidades de DOM
   * ===================================================================== */

  /** Cria elemento sem usar innerHTML (nomes de dispositivos são texto não confiável). */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (v === false || v == null) continue;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  // Ícones fixos (strings constantes do próprio app; nunca dados de dispositivos).
  const ICONS = {
    bluetooth: '<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>',
    watch: '<circle cx="12" cy="12" r="6"/><polyline points="12 9 12 12 13.5 13.5"/><path d="M16.1 7.7 15.5 3.5a1.5 1.5 0 0 0-1.5-1.3h-4a1.5 1.5 0 0 0-1.5 1.3L7.9 7.7m.1 8.6.6 4.2a1.5 1.5 0 0 0 1.5 1.3h4a1.5 1.5 0 0 0 1.5-1.3l.6-4.2"/>',
  };
  function icon(name, size = 22) {
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span.firstChild;
  }

  function setText(id, text) {
    const node = $(id);
    if (node && node.textContent !== text) node.textContent = text;
  }

  /** Acende N das 4 barrinhas conforme a porcentagem de sinal. */
  function paintBars(container, percent) {
    const on = percent >= 75 ? 4 : percent >= 50 ? 3 : percent >= 25 ? 2 : percent > 0 ? 1 : 0;
    [...container.children].forEach((b, i) => b.classList.toggle('on', i < on));
  }

  function makeBars() {
    return el('div', { class: 'bars', 'aria-hidden': 'true' }, el('span'), el('span'), el('span'), el('span'));
  }

  /* =====================================================================
   * Avisos: compatibilidade e erros
   * ===================================================================== */

  function showBanner(id, { kind = 'info', title = '', text = '' }) {
    const box = $(id);
    box.dataset.kind = kind;
    $(id + 'Title').textContent = title;
    $(id + 'Text').textContent = text;
    box.hidden = false;
  }
  const hideBanner = (id) => { $(id).hidden = true; };

  /** Aviso fixo no topo explicando o que ESTE navegador consegue fazer. */
  function renderCompat() {
    const chip = $('modeChip');

    if (!caps.secure) {
      chip.textContent = 'Sem HTTPS'; chip.dataset.ok = 'false';
      showBanner('compat', {
        kind: 'error', title: 'Conexão não segura',
        text: 'A Web Bluetooth só funciona em páginas HTTPS (ou localhost). Publique o site com HTTPS ou abra por http://localhost.',
      });
    } else if (!caps.bluetooth) {
      chip.textContent = 'Navegador incompatível'; chip.dataset.ok = 'false';
      showBanner('compat', {
        kind: 'error',
        title: isIOS ? 'iPhone/iPad não suportam Web Bluetooth no Safari' : 'Este navegador não suporta Web Bluetooth',
        text: isIOS
          ? 'No iOS todos os navegadores usam o motor do Safari, que não tem Web Bluetooth. Alternativa: instale um navegador com suporte, como o Bluefy (App Store), ou use um Android/computador com Chrome ou Edge.'
          : 'Use Chrome, Edge, Opera ou Samsung Internet (Android e computador). Safari e Firefox não suportam Web Bluetooth.',
      });
    } else if (caps.leScan) {
      chip.textContent = 'Varredura BLE disponível'; chip.dataset.ok = 'true';
      showBanner('compat', {
        kind: 'ok', title: 'Varredura contínua disponível',
        text: 'Seu navegador permite escutar anúncios BLE com RSSI em tempo real. O navegador vai pedir permissão ao iniciar.',
      });
    } else {
      chip.textContent = 'Modo seletor'; chip.dataset.ok = 'warn';
      showBanner('compat', {
        kind: 'warn', title: 'Modo seletor (sem varredura contínua)',
        text: 'Seu navegador não expõe a varredura contínua. Você escolherá o dispositivo na janela nativa do navegador' +
          (caps.watch
            ? ' e o app acompanhará o sinal dele. Para listar vários dispositivos de uma vez, ative chrome://flags/#enable-experimental-web-platform-features e reabra o navegador.'
            : '. O RSSI em tempo real também depende desse recurso experimental: ative chrome://flags/#enable-experimental-web-platform-features e reabra o navegador.'),
      });
    }
  }

  /** Converte erros da Web Bluetooth em mensagens claras (em português). */
  function describeError(err) {
    const name = (err && err.name) || '';
    const msg = (err && err.message) || '';
    switch (name) {
      case 'NotFoundError':
        if (/cancel/i.test(msg)) return { kind: 'info', title: 'Seleção cancelada', text: 'Nenhum dispositivo foi escolhido.' };
        return { kind: 'warn', title: 'Nada encontrado', text: 'O navegador não encontrou nenhum dispositivo compatível.' };
      case 'NotAllowedError':
        return {
          kind: 'error', title: 'Permissão Bluetooth negada ou bloqueada',
          text: 'Permita o Bluetooth para este site (ícone de cadeado na barra de endereço). No Android 12+ ative “Dispositivos por perto”; no Android 11 ou anterior, ative a Localização do aparelho.',
        };
      case 'SecurityError':
        return { kind: 'error', title: 'Bloqueado por segurança', text: 'Use a página por HTTPS e abra o site diretamente (não dentro de um quadro/iframe sem permissão de Bluetooth).' };
      case 'NotSupportedError':
        return { kind: 'error', title: 'Recurso não suportado', text: 'Este navegador ou sistema não suporta essa operação Bluetooth.' };
      case 'NetworkError':
        return { kind: 'warn', title: 'Falha ao conectar', text: 'O dispositivo pode estar conectado a outro aparelho, fora do alcance, exigir pareamento ou não aceitar conexões.' };
      case 'InvalidStateError':
        return { kind: 'warn', title: 'Estado inválido', text: 'O Bluetooth ou a conexão não estava pronto. Tente de novo.' };
      case 'AbortError':
        return { kind: 'info', title: 'Operação interrompida', text: 'A operação foi cancelada.' };
      default:
        return { kind: 'error', title: 'Erro inesperado', text: msg || 'Não foi possível concluir a operação.' };
    }
  }

  /* =====================================================================
   * Registro de dispositivos
   * ===================================================================== */

  /** Cria (ou recupera) o registro de um dispositivo pelo id fornecido pelo navegador. */
  function upsert(device) {
    let rec = state.devices.get(device.id);
    if (!rec) {
      rec = {
        id: device.id,
        name: device.name || '',
        rssi: null, //                último RSSI bruto recebido
        txPower: null,
        uuids: new Set(),
        companies: new Set(),
        firstSeen: Date.now(),
        lastSeen: 0, //               0 = nunca recebemos um anúncio
        tracker: new S.SignalTracker(),
        bluetoothDevice: device,
        authorized: false, //         true só se veio do seletor nativo (necessário para GATT)
        watching: false,
        watchError: null,
        abort: null,
        listener: null,
      };
      state.devices.set(device.id, rec);
    } else {
      rec.bluetoothDevice = device;
      if (device.name && !rec.name) rec.name = device.name;
    }
    return rec;
  }

  const selectedRec = () => (state.selectedId ? state.devices.get(state.selectedId) : null);
  const isStale = (rec) => !rec.lastSeen || Date.now() - rec.lastSeen > STALE_AFTER_MS;

  /** Recebe um anúncio BLE (do requestLEScan ou do watchAdvertisements). */
  function handleAdvertisement(evt) {
    if (!evt || !evt.device || seenEvents.has(evt)) return;
    seenEvents.add(evt);

    const rec = upsert(evt.device);
    const now = Date.now();
    rec.lastSeen = now;

    const name = evt.name || evt.device.name;
    if (name) rec.name = name;
    if (typeof evt.rssi === 'number') {
      rec.rssi = evt.rssi;
      rec.tracker.add(evt.rssi, now);
    }
    if (typeof evt.txPower === 'number') rec.txPower = evt.txPower;
    if (evt.uuids) for (const u of evt.uuids) rec.uuids.add(u);
    if (evt.manufacturerData && typeof evt.manufacturerData.keys === 'function') {
      for (const k of evt.manufacturerData.keys()) rec.companies.add(k);
    }
    queueRender();
  }

  /* =====================================================================
   * Busca
   * ===================================================================== */

  function isActive() {
    return state.scanning || state.chooserOpen || [...state.devices.values()].some((r) => r.watching);
  }

  /** Limpa os resultados "ao vivo" (o histórico da sessão é mantido). */
  async function resetLive() {
    await stopSearch(false);
    for (const el_ of cardEls.values()) el_.remove();
    for (const el_ of blipEls.values()) el_.remove();
    cardEls.clear(); blipEls.clear();
    state.devices.clear();
    state.selectedId = null;
    state.order = [];
    hideBanner('alert');
  }

  async function startSearch() {
    hideBanner('alert');

    if (!caps.secure || !caps.bluetooth) {
      renderCompat();
      document.getElementById('compat').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Se o adaptador Bluetooth estiver desligado/ausente, avisamos antes de abrir diálogos.
    try {
      if (typeof navigator.bluetooth.getAvailability === 'function' && !(await navigator.bluetooth.getAvailability())) {
        showBanner('alert', {
          kind: 'error', title: 'Bluetooth indisponível',
          text: 'O navegador não encontrou um adaptador Bluetooth ativo. Ative o Bluetooth do aparelho e tente de novo.',
        });
        return;
      }
    } catch (_) { /* getAvailability pode falhar em alguns navegadores: seguimos em frente */ }

    await resetLive();
    state.started = true;
    state.startedAt = Date.now();

    if (caps.leScan && (await startLeScan())) return;
    await startChooserSearch();
  }

  /** Modo 1: varredura contínua com requestLEScan. Retorna true se iniciou. */
  async function startLeScan() {
    try {
      navigator.bluetooth.addEventListener('advertisementreceived', handleAdvertisement);
      state.scanHandle = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
      state.mode = 'scan';
      state.scanning = true;
      render();
      return true;
    } catch (err) {
      navigator.bluetooth.removeEventListener('advertisementreceived', handleAdvertisement);
      state.scanHandle = null;
      const d = describeError(err);
      showBanner('alert', {
        kind: 'warn', title: 'Varredura contínua indisponível',
        text: `${d.title}: ${d.text} Vou usar o seletor nativo do navegador.`,
      });
      return false;
    }
  }

  /** Modo 2: o usuário escolhe no seletor nativo; depois acompanhamos o sinal. */
  async function startChooserSearch() {
    state.mode = 'chooser';
    state.chooserOpen = true;
    render();
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: COMMON_SERVICES });
      state.chooserOpen = false;
      const rec = upsert(device);
      rec.authorized = true;
      state.selectedId = rec.id;
      await watch(rec);
    } catch (err) {
      state.chooserOpen = false;
      const d = describeError(err);
      if (d.kind !== 'info' || state.devices.size === 0) {
        showBanner('alert', d);
      }
    }
    render();
  }

  /** Pede ao navegador os anúncios (e RSSI) de UM dispositivo já escolhido. */
  async function watch(rec) {
    const dev = rec.bluetoothDevice;
    if (state.mode === 'scan') return; // na varredura os anúncios já chegam
    if (rec.watching) return;
    if (!dev || typeof dev.watchAdvertisements !== 'function') {
      rec.watchError = 'NotSupportedError';
      return;
    }
    rec.abort = typeof AbortController === 'function' ? new AbortController() : null;
    rec.listener = handleAdvertisement;
    dev.addEventListener('advertisementreceived', rec.listener);
    try {
      await dev.watchAdvertisements(rec.abort ? { signal: rec.abort.signal } : undefined);
      rec.watching = true;
      rec.watchError = null;
    } catch (err) {
      dev.removeEventListener('advertisementreceived', rec.listener);
      rec.listener = null;
      rec.watchError = (err && err.name) || 'Error';
    }
  }

  function unwatch(rec) {
    try { if (rec.abort) rec.abort.abort(); } catch (_) { /* nada a fazer */ }
    try {
      if (rec.listener && rec.bluetoothDevice) rec.bluetoothDevice.removeEventListener('advertisementreceived', rec.listener);
      if (rec.watching && rec.bluetoothDevice && typeof rec.bluetoothDevice.unwatchAdvertisements === 'function') rec.bluetoothDevice.unwatchAdvertisements();
    } catch (_) { /* nada a fazer */ }
    rec.listener = null;
    rec.abort = null;
    rec.watching = false;
  }

  async function stopSearch(doRender = true) {
    try { if (state.scanHandle) state.scanHandle.stop(); } catch (_) { /* nada a fazer */ }
    state.scanHandle = null;
    state.scanning = false;
    if (hasBT) navigator.bluetooth.removeEventListener('advertisementreceived', handleAdvertisement);
    for (const rec of state.devices.values()) unwatch(rec);
    if (doRender) render();
  }

  /** Botão "Procurar novamente" / "Escolher outro dispositivo". */
  async function searchAgain() {
    if (state.mode === 'chooser' && isActive()) {
      // Modo seletor em andamento: só abre o seletor de novo e ACRESCENTA outro dispositivo.
      hideBanner('alert');
      await startChooserSearch();
    } else {
      await startSearch();
    }
  }

  /* =====================================================================
   * Seleção, GATT e autorização
   * ===================================================================== */

  function selectDevice(id) {
    state.selectedId = id;
    setText('gattOut', '');
    render();
    beepLoop();
    const panel = $('track');
    if (panel && !panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeTrack() {
    state.selectedId = null;
    render();
  }

  /**
   * O navegador só permite conectar (GATT) a dispositivos que o usuário escolheu no
   * seletor nativo. Dispositivos vistos na varredura precisam dessa autorização extra.
   */
  async function authorize() {
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: COMMON_SERVICES });
      const rec = upsert(device);
      rec.authorized = true;
      const previous = state.selectedId;
      state.selectedId = rec.id;
      if (previous && previous !== rec.id) {
        showBanner('alert', { kind: 'info', title: 'Outro dispositivo escolhido', text: 'Você escolheu um dispositivo diferente do que estava acompanhando; ele foi adicionado à lista.' });
      }
      await watch(rec);
      render();
    } catch (err) {
      const d = describeError(err);
      if (d.kind !== 'info') showBanner('alert', d);
    }
  }

  async function testGatt() {
    const rec = selectedRec();
    if (!rec) return;
    if (!rec.authorized) { await authorize(); return; }

    const out = $('gattOut');
    out.textContent = 'Conectando…';
    $('gattBtn').disabled = true;
    const dev = rec.bluetoothDevice;
    try {
      const server = await dev.gatt.connect();
      const lines = ['Conexão GATT estabelecida.'];
      try {
        const services = await server.getPrimaryServices();
        lines.push(services.length ? `Serviços acessíveis: ${services.map((s) => S.shortUuid(s.uuid)).join(', ')}` : 'Nenhum serviço acessível.');
      } catch (_) {
        lines.push('Não foi possível listar serviços (nenhum dos serviços permitidos existe neste dispositivo).');
      }
      try {
        const battery = await server.getPrimaryService('battery_service');
        const level = await (await battery.getCharacteristic('battery_level')).readValue();
        lines.push(`Bateria informada pelo dispositivo: ${level.getUint8(0)}%`);
      } catch (_) { /* dispositivo sem serviço de bateria acessível: tudo bem */ }
      dev.gatt.disconnect();
      lines.push('Conexão encerrada (o app não mantém conexões abertas).');
      out.textContent = lines.join('\n');
    } catch (err) {
      const d = describeError(err);
      out.textContent = `${d.title}: ${d.text}`;
    } finally {
      $('gattBtn').disabled = false;
      render();
    }
  }

  /* =====================================================================
   * Renderização
   * ===================================================================== */

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    const wait = Math.max(0, RENDER_MIN_INTERVAL - (Date.now() - state.lastRender));
    setTimeout(() => { state.renderQueued = false; render(); }, wait);
  }

  function visibleDevices() {
    return [...state.devices.values()].filter((r) => !state.onlyNamed || r.name);
  }

  function render() {
    state.lastRender = Date.now();
    renderStatus();
    renderList();
    renderBlips();
    renderTrack();
    persistHistory();
    renderHistory();
  }

  /* ---------- Status geral, radar e botões ---------- */

  function modeLabel() {
    if (state.mode === 'scan') return 'Varredura BLE';
    if (state.mode === 'chooser') return 'Seletor';
    return '—';
  }

  function renderStatus() {
    const active = isActive();
    const phase = !state.started ? 'idle' : active ? 'active' : 'stopped';
    $('app').dataset.phase = phase;
    $('radar').classList.toggle('active', active);

    $('startBtn').hidden = phase !== 'idle';
    $('stopBtn').hidden = phase !== 'active';
    const again = $('againBtn');
    again.hidden = !(phase === 'stopped' || (phase === 'active' && state.mode === 'chooser'));
    again.textContent = phase === 'active' && state.mode === 'chooser' ? 'Escolher outro dispositivo' : 'Procurar novamente';

    let caption = 'Pronto para buscar.';
    if (state.chooserOpen) caption = 'Escolha um dispositivo na janela do navegador…';
    else if (state.scanning) caption = state.devices.size ? 'Escutando anúncios Bluetooth LE…' : 'Procurando… nenhum anúncio recebido ainda.';
    else if (phase === 'active') caption = 'Acompanhando o sinal do dispositivo escolhido.';
    else if (phase === 'stopped') caption = 'Busca parada.';
    setText('radarCaption', caption);

    setText('statFound', String(state.devices.size));
    setText('statMode', modeLabel());
    const secs = state.started ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    setText('statTime', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
  }

  /** Blips: anel = proximidade relativa pelo sinal; ângulo é decorativo (não existe direção no BLE). */
  function hashAngle(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return (h % 360) * (Math.PI / 180);
  }

  function renderBlips() {
    const live = new Set();
    for (const rec of visibleDevices()) {
      if (rec.tracker.smoothed === null || isStale(rec)) continue;
      live.add(rec.id);
      let b = blipEls.get(rec.id);
      if (!b) {
        b = el('button', { class: 'blip', type: 'button' });
        b.addEventListener('click', () => selectDevice(rec.id));
        $('blips').append(b);
        blipEls.set(rec.id, b);
      }
      const pct = S.rssiToPercent(rec.tracker.smoothed);
      const radius = 0.1 + (1 - pct / 100) * 0.82; // 0.10 (muito forte) … 0.92 (muito fraco), fração do raio
      const a = hashAngle(rec.id);
      b.style.left = `${50 + 50 * radius * Math.cos(a)}%`;
      b.style.top = `${50 + 50 * radius * Math.sin(a)}%`;
      b.dataset.level = S.classifySignal(rec.tracker.smoothed).level;
      b.classList.toggle('selected', rec.id === state.selectedId);
      b.setAttribute('aria-label', `${rec.name || 'Dispositivo sem nome'}, sinal ${S.classifySignal(rec.tracker.smoothed).label}`);
      b.title = rec.name || 'Dispositivo sem nome';
    }
    for (const [id, b] of blipEls) {
      if (!live.has(id)) { b.remove(); blipEls.delete(id); }
    }
  }

  /* ---------- Lista ---------- */

  function buildCard(rec) {
    const li = el('li', { class: 'dev', tabindex: '0', role: 'button' },
      el('div', { class: 'dev-ico' }),
      el('div', { class: 'dev-main' },
        el('div', { class: 'dev-name' }), el('div', { class: 'dev-sub' }), el('div', { class: 'dev-tags' })),
      el('div', { class: 'dev-sig' }, makeBars(), el('span', { class: 'dev-rssi' })));
    li.addEventListener('click', () => selectDevice(rec.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDevice(rec.id); }
    });
    return li;
  }

  function updateCard(li, rec) {
    const wearable = S.looksLikeWearable(rec.name);
    const sm = rec.tracker.smoothed;
    const sig = S.classifySignal(sm);
    const stale = isStale(rec);

    li.classList.toggle('selected', rec.id === state.selectedId);
    li.classList.toggle('stale', stale);
    li.dataset.level = sig.level;

    const ico = li.querySelector('.dev-ico');
    const want = wearable ? 'watch' : 'bluetooth';
    if (ico.dataset.icon !== want) { ico.replaceChildren(icon(want)); ico.dataset.icon = want; }

    li.querySelector('.dev-name').textContent = rec.name || 'Dispositivo sem nome';
    li.querySelector('.dev-sub').textContent = `ID ${S.shortId(rec.id)} · visto ${rec.lastSeen ? S.formatAgo(Date.now() - rec.lastSeen) : 'nunca'}`;

    const tags = li.querySelector('.dev-tags');
    tags.replaceChildren();
    if (wearable) tags.append(el('span', { class: 'tag' }, 'nome sugere relógio'));
    if (sm !== null) tags.append(el('span', { class: 'tag', 'data-level': sig.level }, sig.label));
    if (rec.authorized) tags.append(el('span', { class: 'tag tag-muted' }, 'conexão permitida'));
    if (stale && rec.lastSeen) tags.append(el('span', { class: 'tag tag-muted' }, 'sem sinal recente'));

    paintBars(li.querySelector('.bars'), sm === null ? 0 : S.rssiToPercent(sm));
    li.querySelector('.dev-rssi').textContent = sm === null ? 'RSSI n/d' : `${Math.round(sm)} dBm`;
  }

  function renderList() {
    const list = $('deviceList');
    const visible = visibleDevices();
    const visibleIds = new Set(visible.map((r) => r.id));

    // Cria/atualiza cartões
    for (const rec of visible) {
      let li = cardEls.get(rec.id);
      if (!li) { li = buildCard(rec); cardEls.set(rec.id, li); }
      updateCard(li, rec);
    }
    // Remove cartões filtrados
    for (const [id, li] of cardEls) {
      if (!visibleIds.has(id)) { li.remove(); cardEls.delete(id); }
    }

    // Ordena (mais forte primeiro), mas só de tempos em tempos para a lista não "pular" sob o dedo
    const now = Date.now();
    const newIds = visible.some((r) => !state.order.includes(r.id));
    if (newIds || now - state.lastSort > SORT_INTERVAL || state.order.length !== visible.length) {
      state.lastSort = now;
      state.order = visible
        .slice()
        .sort((a, b) => (b.tracker.smoothed ?? -999) - (a.tracker.smoothed ?? -999))
        .map((r) => r.id);
      for (const id of state.order) list.append(cardEls.get(id)); // append move o nó existente
    }

    renderEmpty(visible.length);
  }

  function renderEmpty(visibleCount) {
    const box = $('empty');
    const show = state.started && visibleCount === 0;
    box.hidden = !show;
    if (!show) return;

    const reasons = $('emptyReasons');
    const elapsed = Date.now() - state.startedAt;
    const hiddenByFilter = state.onlyNamed && state.devices.size > 0;

    if (hiddenByFilter) {
      setText('emptyTitle', 'Nenhum dispositivo com nome');
      setText('emptyText', `${state.devices.size} dispositivo(s) sem nome estão ocultos. Desmarque “Só com nome” para vê-los.`);
      reasons.hidden = true;
    } else if (state.chooserOpen) {
      setText('emptyTitle', 'Aguardando sua escolha…');
      setText('emptyText', 'Selecione um dispositivo na janela do navegador.');
      reasons.hidden = true;
    } else if (state.scanning && elapsed < NO_SCAN_HINT_AFTER_MS) {
      setText('emptyTitle', 'Procurando dispositivos…');
      setText('emptyText', 'Os dispositivos aparecem aqui assim que enviarem um anúncio Bluetooth.');
      reasons.hidden = true;
    } else if (state.mode === 'chooser') {
      setText('emptyTitle', 'Nenhum dispositivo escolhido');
      setText('emptyText', 'Se o seu dispositivo não apareceu na janela do navegador, veja os possíveis motivos:');
      reasons.hidden = false;
    } else {
      setText('emptyTitle', 'Nenhum dispositivo encontrado (ainda)');
      setText('emptyText', 'Isso é normal em alguns casos. Possíveis motivos:');
      reasons.hidden = false;
    }
  }

  /* ---------- Painel de localização ---------- */

  function renderTrack() {
    const rec = selectedRec();
    const panel = $('track');
    panel.hidden = !rec;
    if (!rec) return;

    const sm = rec.tracker.smoothed;
    const sig = S.classifySignal(sm);
    const stale = isStale(rec);
    const pct = sm === null ? 0 : S.rssiToPercent(sm);

    setText('trName', rec.name || 'Dispositivo sem nome');
    setText('trId', `ID ${S.shortId(rec.id)} (identificador local do navegador, não é o MAC)`);

    $('gauge').dataset.level = sig.level;
    $('gauge').style.setProperty('--p', String(pct));
    $('trSide').dataset.level = sig.level;
    setText('trRssi', sm === null ? '—' : String(Math.round(sm)));
    setText('trLevel', sig.label);
    setText('trPercent', sm === null ? 'sem leitura de RSSI' : `barra: ${pct}% (estimativa)`);
    paintBars($('trBars'), pct);

    // Mensagem de orientação — nunca afirma algo que os dados não sustentam.
    const msg = $('trMsg');
    let text; let kind = 'info';
    if (sm === null && rec.watchError) {
      text = 'Este navegador não fornece o RSSI deste dispositivo em tempo real. Para ativar, use Chrome/Edge e habilite chrome://flags/#enable-experimental-web-platform-features. Você ainda pode ver as informações de conexão abaixo.';
      kind = 'warn';
    } else if (sm === null) {
      text = state.mode === 'chooser' && !isActive()
        ? 'Nenhuma leitura de sinal recebida. Inicie uma nova busca.'
        : 'Aguardando anúncios do dispositivo… ele precisa estar ligado e transmitindo.';
      kind = 'warn';
    } else if (!isActive()) {
      text = `Busca parada: a leitura acima (${Math.round(sm)} dBm) ficou congelada. Toque em “Procurar novamente” para atualizar.`;
      kind = 'warn';
    } else if (stale) {
      text = `Sem anúncios recentes (último ${S.formatAgo(Date.now() - rec.lastSeen)}). O dispositivo pode ter saído do alcance, desligado ou parado de anunciar; a leitura acima está desatualizada.`;
      kind = 'warn';
    } else {
      text = S.trendMessage(rec.tracker.snapshot());
    }
    msg.textContent = text;
    msg.dataset.kind = kind;

    drawChart($('trChart'), rec.tracker.samples);

    // Informações de conexão
    setText('iAdv', rec.lastSeen ? (stale ? `Sem anúncios recentes (último ${S.formatAgo(Date.now() - rec.lastSeen)})` : `Anunciando · último pacote ${S.formatAgo(Date.now() - rec.lastSeen)}`) : 'Nenhum anúncio recebido');
    const gatt = rec.bluetoothDevice && rec.bluetoothDevice.gatt;
    setText('iGatt', gatt && gatt.connected ? 'Conectado' : 'Desconectado');
    setText('iAuth', rec.authorized ? 'Escolhido no seletor (conexão GATT permitida)' : 'Visto na varredura (conexão exige escolher no seletor)');
    setText('iTx', rec.txPower !== null ? `${rec.txPower} dBm` : 'Não informado');
    setText('iUuids', rec.uuids.size ? [...rec.uuids].map(S.shortUuid).join(', ') : 'Nenhum anunciado');
    setText('iCompany', rec.companies.size ? [...rec.companies].map(S.companyLabel).join(', ') : 'Não informado');
    setText('iSource', rec.watching ? 'watchAdvertisements (dispositivo escolhido)' : state.mode === 'scan' ? 'Varredura BLE (requestLEScan)' : 'Sem fonte de RSSI ativa');
    setText('gattBtn', rec.authorized ? 'Testar conexão GATT' : 'Escolher no seletor para conectar');
  }

  /** Gráfico simples do sinal suavizado nos últimos ~90 pontos (linhas tracejadas = limites forte/médio). */
  function drawChart(canvas, samples) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const y = (rssi) => h - 6 - (S.rssiToPercent(rssi) / 100) * (h - 12);

    ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = 'rgba(138,160,200,.8)';
    for (const [v, label] of [[S.STRONG_MIN, 'forte'], [S.MEDIUM_MIN, 'médio']]) {
      ctx.strokeStyle = 'rgba(138,160,200,.3)';
      ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(w, y(v)); ctx.stroke();
      ctx.fillText(`${label} (${v})`, 6, y(v) - 3);
    }
    ctx.setLineDash([]);

    if (samples.length < 2) return;
    const step = w / Math.max(samples.length - 1, 1);
    ctx.beginPath();
    samples.forEach((s, i) => (i ? ctx.lineTo(i * step, y(s.smoothed)) : ctx.moveTo(0, y(s.smoothed))));
    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 2; ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 8; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo((samples.length - 1) * step, h); ctx.lineTo(0, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,212,255,.25)'); g.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = g; ctx.fill();
  }

  /* =====================================================================
   * Histórico da sessão (sessionStorage: some ao fechar a aba)
   * ===================================================================== */

  function loadHistory() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (_) { return []; }
  }

  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch (_) { /* armazenamento indisponível: ignora */ }
  }

  function persistHistory() {
    const now = Date.now();
    if (now - state.lastHistoryPersist < 3000) return;
    state.lastHistoryPersist = now;
    let changed = false;
    for (const rec of state.devices.values()) {
      if (!rec.lastSeen) continue;
      const entry = { id: rec.id, name: rec.name, rssi: rec.tracker.smoothed === null ? null : Math.round(rec.tracker.smoothed), lastSeen: rec.lastSeen };
      const i = state.history.findIndex((h) => h.id === rec.id);
      if (i >= 0) state.history[i] = { ...state.history[i], ...entry, name: entry.name || state.history[i].name };
      else state.history.push(entry);
      changed = true;
    }
    if (changed) {
      state.history.sort((a, b) => b.lastSeen - a.lastSeen);
      state.history.length = Math.min(state.history.length, HISTORY_MAX);
      saveHistory();
    }
  }

  function renderHistory() {
    const section = $('historySection');
    section.hidden = state.history.length === 0;
    if (section.hidden) return;

    // Só redesenha se algo mudou (evita recriar botões enquanto o usuário toca)
    const sig = state.history.map((h) => `${h.id}|${h.name}|${h.rssi}|${Math.floor(h.lastSeen / 60000)}|${state.devices.has(h.id) && !isStale(state.devices.get(h.id))}`).join(';');
    if (sig === state.historySig) return;
    state.historySig = sig;

    const ul = $('historyList');
    ul.replaceChildren();
    for (const h of state.history) {
      const rec = state.devices.get(h.id);
      const live = !!rec && !isStale(rec);
      const time = new Date(h.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const li = el('li', { class: 'dev', 'data-live': String(live) },
        el('div', { class: 'dev-ico' }, icon(S.looksLikeWearable(h.name) ? 'watch' : 'bluetooth')),
        el('div', { class: 'dev-main' },
          el('div', { class: 'dev-name' }, h.name || 'Dispositivo sem nome'),
          el('div', { class: 'dev-sub' }, `ID ${S.shortId(h.id)} · visto às ${time}`)),
        el('div', { class: 'dev-sig' },
          el('span', { class: live ? 'tag' : 'tag tag-muted' }, live ? 'ao vivo' : 'fora de alcance agora'),
          el('span', { class: 'dev-rssi' }, h.rssi === null ? 'RSSI n/d' : `último: ${h.rssi} dBm`)));
      if (live) li.addEventListener('click', () => selectDevice(h.id));
      ul.append(li);
    }
  }

  function clearHistory() {
    state.history = [];
    state.historySig = '';
    saveHistory();
    render();
  }

  /* =====================================================================
   * Bipe e vibração de proximidade (opcional)
   * ===================================================================== */

  let audioCtx = null;
  let beepTimer = null;

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playBeep(pct) {
    if (audioCtx) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime;
      osc.type = 'sine';
      osc.frequency.value = 500 + pct * 6; // mais forte = mais agudo
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.14);
    }
    if (navigator.vibrate) navigator.vibrate(30);
  }

  /** Quanto mais forte o sinal, mais rápido o bipe (1,5 s no mais fraco … 0,2 s no mais forte). */
  function beepLoop() {
    clearTimeout(beepTimer);
    if (!state.sound) return;
    const rec = selectedRec();
    let next = 1000;
    if (rec && rec.tracker.smoothed !== null && !isStale(rec)) {
      const pct = S.rssiToPercent(rec.tracker.smoothed);
      playBeep(pct);
      next = 1500 - pct * 13;
    }
    beepTimer = setTimeout(beepLoop, next);
  }

  /* =====================================================================
   * Inicialização
   * ===================================================================== */

  function init() {
    renderCompat();

    $('startBtn').addEventListener('click', startSearch);
    $('stopBtn').addEventListener('click', () => stopSearch());
    $('againBtn').addEventListener('click', searchAgain);
    $('trClose').addEventListener('click', closeTrack);
    $('gattBtn').addEventListener('click', testGatt);
    $('historyClear').addEventListener('click', clearHistory);
    $('onlyNamed').addEventListener('change', (e) => { state.onlyNamed = e.target.checked; render(); });
    $('soundToggle').addEventListener('change', (e) => {
      state.sound = e.target.checked;
      if (state.sound) ensureAudio(); // precisa nascer de um gesto do usuário
      beepLoop();
    });

    // Atualiza "visto há X s", cronômetro e sinais antigos mesmo sem novos anúncios.
    setInterval(() => { if (state.started || state.history.length) queueRender(); }, 1000);

    // Libera o rádio ao sair da página.
    window.addEventListener('pagehide', () => stopSearch(false));

    render();
  }

  init();
})();
