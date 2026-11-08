/*
 * Testes da lógica de sinal. Rode com:  node signal.test.js
 * (não precisa instalar nada; usa só o módulo 'assert' do Node)
 */
const assert = require('assert');
const S = require('./signal.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok  -', name); }
  catch (e) { console.error('FAIL  -', name, '\n      ', e.message); process.exitCode = 1; }
}

/* ---------- rssiToPercent ---------- */
test('rssiToPercent: limites e meio', () => {
  assert.strictEqual(S.rssiToPercent(-100), 0);
  assert.strictEqual(S.rssiToPercent(-120), 0);
  assert.strictEqual(S.rssiToPercent(-40), 100);
  assert.strictEqual(S.rssiToPercent(-30), 100);
  assert.strictEqual(S.rssiToPercent(-70), 50);
});
test('rssiToPercent: valores inválidos viram 0', () => {
  for (const v of [null, undefined, NaN, 'abc', Infinity]) assert.strictEqual(S.rssiToPercent(v), 0);
});

/* ---------- classifySignal ---------- */
test('classifySignal: forte / médio / fraco / indisponível', () => {
  assert.strictEqual(S.classifySignal(-50).level, 'strong');
  assert.strictEqual(S.classifySignal(-60).level, 'strong');
  assert.strictEqual(S.classifySignal(-61).level, 'medium');
  assert.strictEqual(S.classifySignal(-80).level, 'medium');
  assert.strictEqual(S.classifySignal(-81).level, 'weak');
  assert.strictEqual(S.classifySignal(null).level, 'unknown');
});

/* ---------- SignalTracker ---------- */
test('tracker: começa em "collecting" e sem valor', () => {
  const t = new S.SignalTracker();
  assert.strictEqual(t.trend, 'collecting');
  assert.strictEqual(t.smoothed, null);
  for (let i = 0; i < 5; i++) t.add(-70);
  assert.strictEqual(t.trend, 'collecting');
  t.add(-70);
  assert.strictEqual(t.trend, 'steady');
});
test('tracker: ignora amostras inválidas', () => {
  const t = new S.SignalTracker();
  t.add(NaN); t.add(undefined); t.add('x');
  assert.strictEqual(t.count, 0);
  assert.strictEqual(t.smoothed, null);
});
test('tracker: sinal subindo -> "closer"', () => {
  const t = new S.SignalTracker();
  let rssi = -90;
  for (let i = 0; i < 30; i++) { t.add(rssi); rssi += 1; }
  assert.strictEqual(t.trend, 'closer');
});
test('tracker: sinal caindo -> "farther"', () => {
  const t = new S.SignalTracker();
  let rssi = -50;
  for (let i = 0; i < 30; i++) { t.add(rssi); rssi -= 1; }
  assert.strictEqual(t.trend, 'farther');
});
test('tracker: ruído de ±2 dB em torno de -70 continua "steady"', () => {
  const t = new S.SignalTracker();
  for (let i = 0; i < 60; i++) {
    t.add(-70 + (i % 2 === 0 ? 2 : -2));
    if (i >= 10) assert.strictEqual(t.trend, 'steady', `amostra ${i}`);
  }
});
test('tracker: volta a "steady" depois que o sinal estabiliza', () => {
  const t = new S.SignalTracker();
  let rssi = -90;
  for (let i = 0; i < 25; i++) { t.add(rssi); rssi += 1; }
  assert.strictEqual(t.trend, 'closer');
  for (let i = 0; i < 80; i++) t.add(-65);
  assert.strictEqual(t.trend, 'steady');
});
test('tracker: respeita maxSamples e reset()', () => {
  const t = new S.SignalTracker({ maxSamples: 10 });
  for (let i = 0; i < 50; i++) t.add(-60);
  assert.strictEqual(t.samples.length, 10);
  t.reset();
  assert.strictEqual(t.samples.length, 0);
  assert.strictEqual(t.trend, 'collecting');
});
test('tracker: média suavizada fica entre os extremos', () => {
  const t = new S.SignalTracker();
  t.add(-90); t.add(-50);
  assert.ok(t.smoothed > -90 && t.smoothed < -50);
});

/* ---------- Mensagens ---------- */
test('trendMessage: textos esperados', () => {
  assert.match(S.trendMessage({ trend: 'closer', level: 'medium' }), /chegando mais perto/);
  assert.match(S.trendMessage({ trend: 'farther', level: 'weak' }), /diminuindo/);
  assert.match(S.trendMessage({ trend: 'collecting', level: 'unknown' }), /Coletando/);
  assert.match(S.trendMessage({ trend: 'steady', level: 'strong' }), /forte/);
  assert.match(S.trendMessage({ trend: 'steady', level: 'weak' }), /fraco/);
});
test('trendMessage: nunca promete distância em metros', () => {
  for (const trend of ['collecting', 'closer', 'farther', 'steady'])
    for (const level of ['strong', 'medium', 'weak', 'unknown'])
      assert.doesNotMatch(S.trendMessage({ trend, level }), /\d+\s*(m|metros|cm)\b/);
});

/* ---------- Utilidades ---------- */
test('formatAgo', () => {
  assert.strictEqual(S.formatAgo(500), 'agora');
  assert.strictEqual(S.formatAgo(8000), 'há 8 s');
  assert.strictEqual(S.formatAgo(3 * 60000), 'há 3 min');
  assert.strictEqual(S.formatAgo(2 * 3600000), 'há 2 h');
  assert.strictEqual(S.formatAgo(-1), '—');
});
test('shortId', () => {
  assert.strictEqual(S.shortId(''), '—');
  assert.strictEqual(S.shortId('abc'), 'abc');
  assert.strictEqual(S.shortId('abcdefghijklmnop'), '…klmnop');
});
test('looksLikeWearable', () => {
  assert.ok(S.looksLikeWearable('Mi Smart Band 8'));
  assert.ok(S.looksLikeWearable('Galaxy Watch4 (ABCD)'));
  assert.ok(S.looksLikeWearable('Amazfit GTS'));
  assert.ok(!S.looksLikeWearable('JBL Flip 5'));
  assert.ok(!S.looksLikeWearable(''));
  assert.ok(!S.looksLikeWearable(null));
});
test('shortUuid e companyLabel', () => {
  assert.strictEqual(S.shortUuid('0000180f-0000-1000-8000-00805f9b34fb'), '0x180F');
  assert.strictEqual(S.shortUuid('12345678-1234-1234-1234-123456789abc'), '12345678-1234-1234-1234-123456789abc');
  assert.strictEqual(S.companyLabel(0x004c), 'Apple (0x004C)');
  assert.strictEqual(S.companyLabel(0x1234), '0x1234');
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' — HÁ FALHAS' : ''}.`);
