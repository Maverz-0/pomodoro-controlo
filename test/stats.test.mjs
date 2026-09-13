/* Pruebas de la agregación de tiempo de foco. Ejecuta: node --test test/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* stats.js es un script clásico que cuelga de `window`; lo cargamos con
   un window y un localStorage de mentira. */
function loadStats() {
  const store = new Map();
  const win = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  globalThis.window = win;
  globalThis.localStorage = win.localStorage;
  const src = readFileSync(new URL('../stats.js', import.meta.url), 'utf8');
  new Function('window', 'localStorage', src)(win, win.localStorage);
  return win.Stats;
}

const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min, 0, 0).getTime();
const mins = (ms) => Math.round(ms / 60000);

test('un tramo dentro de una hora cae entero en su cubo', () => {
  const S = loadStats();
  S._raw().segments.push({ s: at(2026, 8, 14, 10, 5), e: at(2026, 8, 14, 10, 35) });
  const h = S.byHour(at(2026, 8, 14, 12));
  assert.equal(mins(h[10]), 30);
  assert.equal(mins(h[9]), 0);
  assert.equal(mins(h[11]), 0);
});

test('un tramo a caballo de dos horas se reparte entre ambas', () => {
  const S = loadStats();
  // 14:50 -> 15:20 = 10 min en la hora 14 y 20 en la 15
  S._raw().segments.push({ s: at(2026, 8, 14, 14, 50), e: at(2026, 8, 14, 15, 20) });
  const h = S.byHour(at(2026, 8, 14, 3));
  assert.equal(mins(h[14]), 10);
  assert.equal(mins(h[15]), 20);
  assert.equal(mins(h.reduce((a, b) => a + b, 0)), 30, 'no debe perderse ni inventarse tiempo');
});

test('un tramo que cruza la medianoche se parte entre los dos días', () => {
  const S = loadStats();
  S._raw().segments.push({ s: at(2026, 8, 14, 23, 40), e: at(2026, 8, 15, 0, 25) });
  const dia14 = S.byHour(at(2026, 8, 14, 12));
  const dia15 = S.byHour(at(2026, 8, 15, 12));
  assert.equal(mins(dia14[23]), 20);
  assert.equal(mins(dia15[0]), 25);
  assert.equal(mins(dia14.reduce((a, b) => a + b, 0)), 20, 'el día 14 solo se queda su parte');
});

test('byWeekday reparte por día con el lunes primero', () => {
  const S = loadStats();
  // 14 sep 2026 es lunes.
  S._raw().segments.push({ s: at(2026, 8, 14, 9), e: at(2026, 8, 14, 10) });   // lunes 60
  S._raw().segments.push({ s: at(2026, 8, 16, 9), e: at(2026, 8, 16, 9, 30) }); // miércoles 30
  S._raw().segments.push({ s: at(2026, 8, 20, 9), e: at(2026, 8, 20, 9, 15) }); // domingo 15
  const w = S.byWeekday(at(2026, 8, 16, 12));
  assert.equal(mins(w[0]), 60, 'lunes');
  assert.equal(mins(w[2]), 30, 'miércoles');
  assert.equal(mins(w[6]), 15, 'domingo');
  assert.equal(mins(w[1]), 0);
});

test('byWeekday no mezcla semanas contiguas', () => {
  const S = loadStats();
  S._raw().segments.push({ s: at(2026, 8, 14, 9), e: at(2026, 8, 14, 10) });  // semana del 14
  S._raw().segments.push({ s: at(2026, 8, 21, 9), e: at(2026, 8, 21, 10) });  // semana del 21
  const w = S.byWeekday(at(2026, 8, 16, 12));
  assert.equal(mins(w.reduce((a, b) => a + b, 0)), 60, 'solo la semana pedida');
});

test('byWeekOfMonth cubre el mes y no se sale de él', () => {
  const S = loadStats();
  S._raw().segments.push({ s: at(2026, 8, 1, 9), e: at(2026, 8, 1, 10) });    // 1 sep
  S._raw().segments.push({ s: at(2026, 8, 30, 9), e: at(2026, 8, 30, 10) });  // 30 sep
  S._raw().segments.push({ s: at(2026, 7, 31, 9), e: at(2026, 7, 31, 10) });  // 31 ago, fuera
  S._raw().segments.push({ s: at(2026, 9, 1, 9), e: at(2026, 9, 1, 10) });    // 1 oct, fuera
  const { buckets, weeks } = S.byWeekOfMonth(2026, 8);
  assert.equal(mins(buckets.reduce((a, b) => a + b, 0)), 120, 'solo lo de septiembre');
  assert.ok(weeks.length >= 4 && weeks.length <= 6, `semanas inesperadas: ${weeks.length}`);
});

test('los tramos por debajo del mínimo se descartan', () => {
  const S = loadStats();
  S.begin(null);
  S.close(Date.now() + 300);          // 0,3 s
  assert.equal(S.count(), 0);
});

test('reconcile cierra en el tope un tramo que quedó abierto al morir la app', () => {
  const S = loadStats();
  const cap = Date.now() - 60000;      // el bloque venció hace un minuto
  S._raw().open = { s: cap - 25 * 60000, cap };
  S.reconcile(true);
  assert.equal(S.hasOpen(), false, 'debe quedar cerrado');
  assert.equal(S.count(), 1);
  const seg = S._raw().segments[0];
  assert.equal(seg.e, cap, 'no puede contar más allá del fin del bloque');
  assert.equal(mins(seg.e - seg.s), 25);
});

test('reconcile respeta un tramo que sigue vivo', () => {
  const S = loadStats();
  S._raw().open = { s: Date.now() - 60000, cap: Date.now() + 600000 };
  S.reconcile(true);
  assert.equal(S.hasOpen(), true);
});

test('withOpen incluye el tramo en curso sin ensuciar lo guardado', () => {
  const S = loadStats();
  // El tramo abierto se cierra en "ahora", así que arranca cinco minutos atrás.
  const ahora = Date.now();
  const inicio = ahora - 5 * 60000;
  S._raw().open = { s: inicio, cap: null };
  const antes = S.count();

  const h = S.withOpen(() => S.byHour(ahora));
  const total = h.reduce((a, b) => a + b, 0);
  assert.ok(total > 0, 'el tiempo en curso debe aparecer');
  assert.equal(mins(total), 5);
  assert.ok(h[new Date(ahora).getHours()] > 0 || h[new Date(inicio).getHours()] > 0,
            'debe caer en la hora en curso o en la anterior si cruzó la frontera');

  assert.equal(S.count(), antes, 'no debe persistirse como tramo cerrado');
  assert.equal(S.hasOpen(), true, 'el tramo sigue abierto tras consultarlo');
});
