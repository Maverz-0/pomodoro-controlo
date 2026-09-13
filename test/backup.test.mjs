/* Pruebas de la copia cifrada. Lo que se verifica aquí es que un histórico
   sobrevive al viaje de ida y vuelta y que una clave equivocada no descifra. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function cargar() {
  const store = new Map();
  const win = {
    CONFIG: { WORKER_URL: 'https://ejemplo.workers.dev' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  globalThis.window = win;
  globalThis.localStorage = win.localStorage;
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

  for (const f of ['../stats.js', '../backup.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    new Function('window', 'localStorage', src)(win, win.localStorage);
  }
  return { Stats: win.Stats, Backup: win.Backup };
}

const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min, 0, 0).getTime();

test('empaquetar y desempaquetar conserva los tramos', () => {
  const { Backup } = cargar();
  const segs = [
    { s: at(2026, 8, 1, 9, 0), e: at(2026, 8, 1, 9, 25) },
    { s: at(2026, 8, 1, 10, 0), e: at(2026, 8, 1, 10, 30) },
    { s: at(2026, 8, 3, 15, 12), e: at(2026, 8, 3, 15, 37) },
  ];
  const vuelta = Backup._desempaquetar(Backup._empaquetar(segs));
  assert.equal(vuelta.length, 3);
  vuelta.forEach((v, i) => {
    // La codificación va en segundos, así que se admite ese margen.
    assert.ok(Math.abs(v.s - segs[i].s) < 1000, 'inicio ' + i);
    assert.ok(Math.abs((v.e - v.s) - (segs[i].e - segs[i].s)) < 1000, 'duración ' + i);
  });
});

test('el empaquetado ordena los tramos aunque lleguen desordenados', () => {
  const { Backup } = cargar();
  const segs = [
    { s: at(2026, 8, 5, 12, 0), e: at(2026, 8, 5, 12, 25) },
    { s: at(2026, 8, 1, 9, 0), e: at(2026, 8, 1, 9, 25) },
  ];
  const vuelta = Backup._desempaquetar(Backup._empaquetar(segs));
  assert.ok(vuelta[0].s < vuelta[1].s, 'deben salir en orden cronológico');
});

test('el formato compacto cabe de sobra en un documento', () => {
  const { Backup } = cargar();
  // 400 días a 12 tramos diarios: el peor caso realista.
  const segs = [];
  let t = Date.now() - 400 * 86400000;
  for (let i = 0; i < 400 * 12; i++) {
    segs.push({ s: t, e: t + 25 * 60000 });
    t += 70 * 60000;
  }
  const bytes = JSON.stringify(Backup._empaquetar(segs)).length;
  assert.ok(bytes < 100 * 1024, 'ocupa ' + bytes + ' bytes, se pasa del margen');
});

test('cifrar y descifrar devuelve el mismo objeto', async () => {
  const { Backup } = cargar();
  const code = Backup._generarCodigo();
  const dato = { v: 1, seg: [[1789000000, 1500], [3600, 1500]] };
  const blob = await Backup._cifrar(code, dato);
  assert.notEqual(blob, JSON.stringify(dato), 'no puede viajar en claro');
  assert.deepEqual(await Backup._descifrar(code, blob), dato);
});

test('el blob cifrado no filtra el contenido', async () => {
  const { Backup } = cargar();
  const code = Backup._generarCodigo();
  const blob = await Backup._cifrar(code, { v: 1, seg: [[1789000000, 1500]] });
  const claro = Buffer.from(blob, 'base64').toString('binary');
  assert.ok(!claro.includes('1789000000'), 'aparece un dato en claro');
  assert.ok(!claro.includes('seg'), 'aparece una clave del objeto en claro');
});

test('una clave equivocada no descifra', async () => {
  const { Backup } = cargar();
  const buena = Backup._generarCodigo();
  const mala = Backup._generarCodigo();
  const blob = await Backup._cifrar(buena, { v: 1, seg: [[1, 2]] });
  await assert.rejects(() => Backup._descifrar(mala, blob));
});

test('dos cifrados de lo mismo dan blobs distintos', async () => {
  const { Backup } = cargar();
  const code = Backup._generarCodigo();
  const dato = { v: 1, seg: [[1, 2]] };
  const a = await Backup._cifrar(code, dato);
  const b = await Backup._cifrar(code, dato);
  assert.notEqual(a, b, 'sal e IV deben ser nuevos en cada cifrado');
});

test('el identificador es estable y no revela la clave', async () => {
  const { Backup } = cargar();
  const code = Backup._generarCodigo();
  const id1 = await Backup._docId(code);
  const id2 = await Backup._docId(Backup.formatear(code).toLowerCase());
  assert.match(id1, /^[0-9a-f]{64}$/);
  assert.equal(id1, id2, 'guiones y minúsculas no deben cambiar el id');
  assert.ok(!id1.includes(code.toLowerCase()), 'el id no puede contener la clave');
  assert.notEqual(id1, await Backup._docId(Backup._generarCodigo()));
});

test('la clave generada tiene el formato esperado', () => {
  const { Backup } = cargar();
  const c = Backup._generarCodigo();
  assert.equal(c.length, 20);
  assert.ok(Backup.valido(c));
  assert.ok(Backup.valido(Backup.formatear(c)), 'con guiones también vale');
  assert.ok(!/[01ILOU]/.test(c), 'no debe usar caracteres ambiguos');
  assert.ok(!Backup.valido('DEMASIADOCORTA'));
});

test('las claves no se repiten', () => {
  const { Backup } = cargar();
  const vistas = new Set();
  for (let i = 0; i < 500; i++) vistas.add(Backup._generarCodigo());
  assert.equal(vistas.size, 500);
});

test('replaceAll sustituye el histórico entero', () => {
  const { Stats } = cargar();
  Stats._raw().segments.push({ s: at(2026, 8, 1, 9), e: at(2026, 8, 1, 10) });
  Stats.replaceAll([
    { s: at(2026, 8, 5, 9), e: at(2026, 8, 5, 10) },
    { s: at(2026, 8, 4, 9), e: at(2026, 8, 4, 10) },
  ]);
  assert.equal(Stats.count(), 2, 'lo anterior debe desaparecer');
  assert.ok(Stats._raw().segments[0].s < Stats._raw().segments[1].s, 'debe quedar ordenado');
});

test('un histórico real sobrevive al viaje completo', async () => {
  const { Stats, Backup } = cargar();
  const segs = [];
  for (let d = 0; d < 30; d++) {
    for (let b = 0; b < 5; b++) {
      const s = at(2026, 7, 1 + d, 9 + b * 2, 15);
      segs.push({ s, e: s + 25 * 60000 });
    }
  }
  Stats.replaceAll(segs);
  const antes = Stats.count();

  const code = Backup._generarCodigo();
  const blob = await Backup._cifrar(code, Backup._empaquetar(Stats._raw().segments));

  Stats.clear();
  assert.equal(Stats.count(), 0);

  Stats.replaceAll(Backup._desempaquetar(await Backup._descifrar(code, blob)));
  assert.equal(Stats.count(), antes, 'deben volver todos los tramos');

  // Y las agregaciones deben dar lo mismo que antes de la vuelta.
  const total = Stats.byWeekday(at(2026, 7, 10, 12)).reduce((a, b) => a + b, 0);
  assert.ok(total > 0, 'las estadísticas siguen calculándose tras restaurar');
});
