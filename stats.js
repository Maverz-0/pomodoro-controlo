/* Registro y agregación del tiempo de foco.

   Solo cuenta el tiempo con el temporizador corriendo en modo foco: se abre un
   tramo al pulsar Empezar y se cierra al pausar, reiniciar, saltar, cambiar de
   modo o completar el bloque. Los tramos se guardan como pares de marcas de
   tiempo, así que cerrar la app no pierde lo acumulado. */

window.Stats = (() => {
  const KEY = 'pomodoro.focus.v1';
  const RETENTION_DAYS = 400;
  const MIN_SEGMENT_MS = 1000;   // ignora toques accidentales de Empezar/Pausar

  let data = { segments: [], open: null };

  /* ---------- persistencia ---------- */

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && Array.isArray(raw.segments)) {
        data = { segments: raw.segments, open: raw.open || null };
      }
    } catch {}
    prune();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
  }

  function prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const before = data.segments.length;
    data.segments = data.segments.filter((seg) => seg.e > cutoff);
    if (data.segments.length !== before) save();
  }

  /* ---------- apertura y cierre de tramos ---------- */

  /* `cap` es el instante en que el bloque terminaría solo: si la app muere,
     al volver sabemos hasta dónde pudo llegar el foco como mucho. */
  function begin(cap) {
    if (data.open) close(Date.now());
    data.open = { s: Date.now(), cap: cap || null };
    save();
  }

  function close(at) {
    if (!data.open) return;
    const end = Math.min(at, data.open.cap || at);
    if (end - data.open.s >= MIN_SEGMENT_MS) {
      data.segments.push({ s: data.open.s, e: end });
    }
    data.open = null;
    save();
  }

  /* Al arrancar la app: si quedó un tramo abierto de una sesión anterior,
     ciérralo en el instante en que el bloque habría terminado. */
  function reconcile(stillRunning) {
    if (!data.open) return;
    const cap = data.open.cap;
    if (!stillRunning || (cap && Date.now() >= cap)) {
      close(cap || Date.now());
    }
  }

  const hasOpen = () => !!data.open;

  /* ---------- agregación ---------- */

  /* Reparte un tramo entre los cubos que toca, partiéndolo en las fronteras
     que marque `boundary`. Sin esto, un foco de 14:50 a 15:20 se contaría
     entero en una sola hora. */
  function distribute(from, to, boundary, bucketOf, buckets) {
    for (const seg of data.segments) {
      let t = Math.max(seg.s, from);
      const end = Math.min(seg.e, to);
      while (t < end) {
        const chunkEnd = Math.min(boundary(t), end);
        const i = bucketOf(t);
        if (i >= 0 && i < buckets.length) buckets[i] += chunkEnd - t;
        t = chunkEnd;
      }
    }
    return buckets;
  }

  const nextHour = (t) => new Date(t).setMinutes(60, 0, 0);
  const nextDay  = (t) => new Date(t).setHours(24, 0, 0, 0);

  const startOfDay = (d) => new Date(d).setHours(0, 0, 0, 0);

  /* Lunes como primer día de la semana. */
  function startOfWeek(d) {
    const x = new Date(startOfDay(d));
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x.getTime();
  }

  /* Minutos de foco por hora (0–23) de un día concreto. */
  function byHour(dayTs) {
    const from = startOfDay(dayTs);
    const to = nextDay(from);
    return distribute(from, to, nextHour, (t) => new Date(t).getHours(), new Array(24).fill(0));
  }

  /* Minutos de foco por día (lun–dom) de una semana concreta. */
  function byWeekday(weekTs) {
    const from = startOfWeek(weekTs);
    const to = from + 7 * 86400000;
    return distribute(from, to, nextDay, (t) => (new Date(t).getDay() + 6) % 7, new Array(7).fill(0));
  }

  /* Minutos de foco por semana dentro de un mes. Las semanas se cortan por
     lunes, así que la primera y la última pueden estar incompletas. */
  function byWeekOfMonth(year, month) {
    const first = new Date(year, month, 1).getTime();
    const last = new Date(year, month + 1, 1).getTime();
    const weeks = [];
    for (let w = startOfWeek(first); w < last; w += 7 * 86400000) {
      weeks.push({ start: w, end: Math.min(w + 7 * 86400000, last) });
    }
    const buckets = new Array(weeks.length).fill(0);
    const idxOf = (t) => weeks.findIndex((w) => t >= w.start && t < w.end);
    distribute(first, last, nextDay, idxOf, buckets);
    return { buckets, weeks };
  }

  /* Incluye el tramo abierto para que la vista de hoy no parezca vacía
     mientras el temporizador corre. */
  function withOpen(fn) {
    const snapshot = data.segments;
    if (data.open) {
      data.segments = [...snapshot, { s: data.open.s, e: Date.now() }];
    }
    try { return fn(); } finally { data.segments = snapshot; }
  }

  function totalBetween(from, to) {
    let ms = 0;
    for (const seg of data.segments) {
      ms += Math.max(0, Math.min(seg.e, to) - Math.max(seg.s, from));
    }
    return ms;
  }

  const count = () => data.segments.length;
  const clear = () => { data = { segments: [], open: null }; save(); };

  load();

  return {
    begin, close, reconcile, hasOpen,
    byHour, byWeekday, byWeekOfMonth, withOpen, totalBetween,
    startOfDay, startOfWeek, count, clear,
    _raw: () => data,
  };
})();
