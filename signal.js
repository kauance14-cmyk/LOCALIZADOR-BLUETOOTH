/*!
 * Smart Finder — lógica pura de sinal.
 *
 * Este arquivo NÃO usa DOM nem Bluetooth: só recebe números (RSSI em dBm)
 * e devolve classificações e mensagens. Por isso pode ser testado no Node
 * (veja signal.test.js) e usado no navegador (window.SmartSignal).
 *
 * IMPORTANTE: RSSI é uma estimativa grosseira de proximidade. Ele varia com
 * o corpo da pessoa, paredes, antena do aparelho e interferência. Nada aqui
 * converte RSSI em metros — isso seria inventar um dado que não temos.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node (testes)
  else root.SmartSignal = api; // Navegador
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Constantes de classificação (dBm) ---------- */
  const RSSI_FLOOR = -100; // ~0% na barra
  const RSSI_CEIL = -40; //   ~100% na barra
  const STRONG_MIN = -60; //  >= -60 dBm  -> forte
  const MEDIUM_MIN = -80; //  >= -80 dBm  -> médio; abaixo disso -> fraco

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /** Converte RSSI (dBm) em 0–100 só para desenhar barras/medidor. */
  function rssiToPercent(rssi) {
    if (!isNum(rssi)) return 0;
    return Math.round(clamp((rssi - RSSI_FLOOR) / (RSSI_CEIL - RSSI_FLOOR), 0, 1) * 100);
  }

  /** Classifica o sinal em forte / médio / fraco (ou indisponível). */
  function classifySignal(rssi) {
    if (!isNum(rssi)) return { level: 'unknown', label: 'Indisponível' };
    if (rssi >= STRONG_MIN) return { level: 'strong', label: 'Forte' };
    if (rssi >= MEDIUM_MIN) return { level: 'medium', label: 'Médio' };
    return { level: 'weak', label: 'Fraco' };
  }

  /**
   * Acompanha amostras de RSSI de UM dispositivo.
   *
   * - `smoothed`: média móvel exponencial rápida (reduz o ruído que é normal no RSSI).
   * - `trend`: compara a média rápida com uma média lenta (como um "MACD"):
   *      rápida bem acima da lenta  -> sinal subindo  ('closer')
   *      rápida bem abaixo da lenta -> sinal caindo   ('farther')
   *   Usa histerese (limiar de entrada maior que o de saída) para a mensagem
   *   não ficar piscando entre estados.
   */
  class SignalTracker {
    constructor(opts = {}) {
      this.fastAlpha = opts.fastAlpha ?? 0.3;
      this.slowAlpha = opts.slowAlpha ?? 0.08;
      this.maxSamples = opts.maxSamples ?? 90;
      this.minSamples = opts.minSamples ?? 6; // antes disso: 'collecting'
      this.enter = opts.enter ?? 2.0; // dB para ENTRAR em closer/farther
      this.exit = opts.exit ?? 1.0; //  dB para SAIR de closer/farther
      this.reset();
    }

    reset() {
      this.samples = []; // [{ t, raw, smoothed }]
      this.smoothed = null; // média rápida (valor mostrado)
      this.slow = null;
      this.count = 0;
      this.trend = 'collecting';
    }

    add(rssi, t = Date.now()) {
      if (!isNum(rssi)) return this.snapshot();
      this.count += 1;
      this.smoothed = this.smoothed === null ? rssi : this.smoothed + this.fastAlpha * (rssi - this.smoothed);
      this.slow = this.slow === null ? rssi : this.slow + this.slowAlpha * (rssi - this.slow);

      this.samples.push({ t, raw: rssi, smoothed: this.smoothed });
      if (this.samples.length > this.maxSamples) this.samples.shift();

      this.trend = this._nextTrend(this.smoothed - this.slow);
      return this.snapshot();
    }

    _nextTrend(diff) {
      if (this.count < this.minSamples) return 'collecting';
      if (this.trend === 'closer') {
        if (diff > this.exit) return 'closer';
        return diff < -this.enter ? 'farther' : 'steady';
      }
      if (this.trend === 'farther') {
        if (diff < -this.exit) return 'farther';
        return diff > this.enter ? 'closer' : 'steady';
      }
      if (diff > this.enter) return 'closer';
      if (diff < -this.enter) return 'farther';
      return 'steady';
    }

    snapshot() {
      const last = this.samples[this.samples.length - 1];
      return {
        raw: last ? last.raw : null,
        smoothed: this.smoothed,
        trend: this.trend,
        level: classifySignal(this.smoothed).level,
        count: this.count,
      };
    }
  }

  /** Texto de orientação para o usuário, conforme tendência e nível. */
  function trendMessage({ trend, level }) {
    if (trend === 'collecting') return 'Coletando amostras de sinal… mova-se devagar.';
    if (trend === 'closer') return 'Sinal aumentando: você está chegando mais perto.';
    if (trend === 'farther') return 'Sinal diminuindo: você pode estar se afastando. Tente outra direção.';
    if (level === 'strong') return 'Sinal forte e estável: o dispositivo deve estar bem perto. Olhe em bolsos, bolsas e embaixo de objetos.';
    if (level === 'medium') return 'Sinal médio e estável: continue andando devagar e veja se ele aumenta.';
    return 'Sinal fraco e estável: tente se aproximar de lugares onde o dispositivo possa estar.';
  }

  /* ---------- Utilidades de exibição ---------- */

  /** "agora", "há 8 s", "há 3 min". */
  function formatAgo(ms) {
    if (!isNum(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 2) return 'agora';
    if (s < 60) return `há ${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `há ${m} min`;
    return `há ${Math.floor(m / 60)} h`;
  }

  /**
   * O navegador NÃO revela o endereço MAC: o `id` é um texto opaco, diferente
   * por site. Mostramos só o final dele como identificador curto.
   */
  function shortId(id) {
    if (!id) return '—';
    const s = String(id);
    return s.length <= 8 ? s : '…' + s.slice(-6);
  }

  /** Nomes que sugerem relógio/pulseira. É só um palpite pelo nome, não uma garantia. */
  const WEARABLE_RE = /watch|band|amazfit|zepp|garmin|fossil|fitbit|galaxy\s?(fit|watch)|gear|huawei|honor|redmi|mi\s?smart|ticwatch|polar|suunto|whoop|oura|coros|pebble|forerunner|fenix|venu|vivo(active|smart|fit)|colmi|smartwatch/i;
  function looksLikeWearable(name) {
    return typeof name === 'string' && WEARABLE_RE.test(name);
  }

  /** UUID de 16 bits embutido no UUID base Bluetooth -> "0x180F". */
  function shortUuid(uuid) {
    const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(String(uuid));
    return m ? '0x' + m[1].toUpperCase() : String(uuid);
  }

  /** Alguns IDs de fabricante (Bluetooth SIG company identifiers) que conheço com certeza. */
  const COMPANIES = { 0x0006: 'Microsoft', 0x004c: 'Apple', 0x0075: 'Samsung', 0x0087: 'Garmin', 0x00e0: 'Google', 0x027d: 'Huawei' };
  function companyLabel(id) {
    const hex = '0x' + Number(id).toString(16).toUpperCase().padStart(4, '0');
    return COMPANIES[id] ? `${COMPANIES[id]} (${hex})` : hex;
  }

  return {
    RSSI_FLOOR, RSSI_CEIL, STRONG_MIN, MEDIUM_MIN,
    rssiToPercent, classifySignal, SignalTracker, trendMessage,
    formatAgo, shortId, looksLikeWearable, shortUuid, companyLabel,
  };
});
