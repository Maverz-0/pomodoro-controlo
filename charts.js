/* Vista de estadísticas: tres lecturas del tiempo de foco.

   Una sola serie, así que un único color para todas las barras (nada de
   degradar por valor, que duplicaría en color lo que ya dice la altura) y
   sin leyenda: el título ya dice qué se está midiendo. El dato exacto de
   cada barra vive en el detalle que aparece al tocarla. */

window.Charts = (() => {
  const VB = { w: 360, h: 200, padL: 34, padR: 6, padT: 10, plotH: 150 };
  const BAR_MAX = 24;   // tope de grosor: el resto de la ranura es aire
  const GAP = 2;        // separación entre barras, en color de superficie

  const fmt = {
    mes:      new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }),
    diaLargo: new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    diaCorto: new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }),
  };
  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  // Iniciales a la española: X para miércoles, si no M saldría dos veces.
  const INICIALES = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  /* ---------- formato de duración ---------- */

  function dur(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    const r = min % 60;
    return r ? h + ' h ' + r + ' min' : h + ' h';
  }

  /* Escalón de eje redondo, en minutos. */
  function niceMax(msMax) {
    const min = msMax / 60000;
    if (min <= 0) return 60 * 60000;
    for (const step of [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720]) {
      if (min <= step) return step * 60000;
    }
    return Math.ceil(min / 120) * 120 * 60000;
  }

  /* ---------- estado de la vista ---------- */

  let range = 'hour';       // hour | weekday | week
  let cursor = Date.now();  // día, semana o mes según el rango
  let selected = -1;

  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function etiquetaDia(day) {
    const hoy = Stats.startOfDay(Date.now());
    const t = day.getTime();
    if (t === hoy) return 'Hoy';
    if (t === hoy - 86400000) return 'Ayer';
    return cap1(fmt.diaLargo.format(day));
  }

  function etiquetaSemana(ini, fin) {
    if (Stats.startOfWeek(Date.now()) === ini.getTime()) return 'Esta semana';
    return fmt.diaCorto.format(ini) + ' – ' + fmt.diaCorto.format(fin);
  }

  /* ---------- construcción de los datos de cada rango ---------- */

  function build() {
    if (range === 'hour') {
      const values = Stats.withOpen(() => Stats.byHour(cursor));
      const day = new Date(Stats.startOfDay(cursor));
      return {
        values,
        // Etiqueta cada 6 h: 24 números seguidos no se leen.
        ticks: values.map((_, i) => (i % 6 === 0 ? String(i) : '')),
        label: etiquetaDia(day),
        detalle: (i) => pad(i) + ':00–' + pad((i + 1) % 24) + ':00 · ' + fmt.diaLargo.format(day),
        sub: 'Por hora del día',
      };
    }

    if (range === 'weekday') {
      const values = Stats.withOpen(() => Stats.byWeekday(cursor));
      const ini = new Date(Stats.startOfWeek(cursor));
      const fin = new Date(Stats.startOfWeek(cursor) + 6 * 86400000);
      return {
        values,
        ticks: INICIALES,
        label: etiquetaSemana(ini, fin),
        detalle: (i) => {
          const d = new Date(Stats.startOfWeek(cursor) + i * 86400000);
          return DIAS[i] + ' · ' + fmt.diaLargo.format(d);
        },
        sub: 'Por día de la semana',
      };
    }

    const d = new Date(cursor);
    const mesIni = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const mesFin = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const res = Stats.withOpen(() => Stats.byWeekOfMonth(d.getFullYear(), d.getMonth()));
    return {
      values: res.buckets,
      ticks: res.buckets.map((_, i) => 'S' + (i + 1)),
      label: cap1(fmt.mes.format(d)),
      detalle: (i) => {
        const w = res.weeks[i];
        // Las semanas se cortan en lunes, así que la primera puede empezar en el
        // mes anterior. Se recorta al mes que se está viendo para no enseñar
        // una fecha de fuera del periodo.
        const desde = new Date(Math.max(w.start, mesIni));
        const hasta = new Date(Math.min(w.end, mesFin) - 86400000);
        const rango = desde.getTime() === hasta.getTime()
          ? fmt.diaCorto.format(desde)
          : fmt.diaCorto.format(desde) + ' – ' + fmt.diaCorto.format(hasta);
        return 'Semana ' + (i + 1) + ' · ' + rango;
      },
      sub: 'Por semana del mes',
    };
  }

  const pad = (n) => String(n).padStart(2, '0');

  /* ¿Se puede avanzar sin caer en el futuro? */
  function puedeAvanzar() {
    const ahora = Date.now();
    if (range === 'hour') return Stats.startOfDay(cursor) < Stats.startOfDay(ahora);
    if (range === 'weekday') return Stats.startOfWeek(cursor) < Stats.startOfWeek(ahora);
    const c = new Date(cursor), n = new Date(ahora);
    return c.getFullYear() < n.getFullYear()
        || (c.getFullYear() === n.getFullYear() && c.getMonth() < n.getMonth());
  }

  function mover(dir) {
    if (dir > 0 && !puedeAvanzar()) return;
    const d = new Date(cursor);
    if (range === 'hour') cursor = Stats.startOfDay(cursor) + dir * 86400000;
    else if (range === 'weekday') cursor = Stats.startOfWeek(cursor) + dir * 7 * 86400000;
    else cursor = new Date(d.getFullYear(), d.getMonth() + dir, 1).getTime();
    selected = -1;
    render();
  }

  /* ---------- dibujo ---------- */

  function etiquetaEjeY(ms) {
    const min = Math.round(ms / 60000);
    if (min === 0) return '0';
    if (min < 60) return min + 'm';
    const h = min / 60;
    return (min % 60 ? h.toFixed(1) : String(h)) + 'h';
  }

  function svgFor(data) {
    const values = data.values;
    const n = values.length;
    const plotW = VB.w - VB.padL - VB.padR;
    const slot = plotW / n;
    const barW = Math.min(BAR_MAX, Math.max(2, slot - GAP));
    const base = VB.padT + VB.plotH;
    const max = niceMax(Math.max.apply(null, values));

    const y = (v) => base - (v / max) * VB.plotH;
    const x = (i) => VB.padL + i * slot + (slot - barW) / 2;

    // Rejilla: líneas finas y continuas, un paso por encima del fondo.
    const grid = [0, 0.5, 1].map((f) => {
      const gy = base - f * VB.plotH;
      return '<line class="grid" x1="' + VB.padL + '" y1="' + gy + '" x2="' + (VB.w - VB.padR) + '" y2="' + gy + '"/>'
           + '<text class="axis-y" x="' + (VB.padL - 6) + '" y="' + (gy + 3.5) + '" text-anchor="end">'
           + etiquetaEjeY(f * max) + '</text>';
    }).join('');

    const barras = values.map((v, i) => {
      // Extremo redondeado 4px arriba, recto sobre la línea base.
      const alto = v > 0 ? Math.max(2, base - y(v)) : 0;
      const r = Math.min(4, barW / 2, alto);
      const bx = x(i), by = base - alto;
      const path = alto === 0 ? '' :
        '<path class="bar' + (i === selected ? ' is-sel' : '') + '" d="'
        + 'M' + bx + ' ' + base
        + ' L' + bx + ' ' + (by + r)
        + ' Q' + bx + ' ' + by + ' ' + (bx + r) + ' ' + by
        + ' L' + (bx + barW - r) + ' ' + by
        + ' Q' + (bx + barW) + ' ' + by + ' ' + (bx + barW) + ' ' + (by + r)
        + ' L' + (bx + barW) + ' ' + base + ' Z"/>';
      // Zona táctil holgada: toda la ranura, no solo la barra.
      const hit = '<rect class="hit" x="' + (VB.padL + i * slot) + '" y="' + VB.padT
        + '" width="' + slot + '" height="' + VB.plotH + '" data-i="' + i + '"/>';
      return path + hit;
    }).join('');

    const ejeX = data.ticks.map((t, i) => t
      ? '<text class="axis-x" x="' + (VB.padL + i * slot + slot / 2) + '" y="' + (base + 16)
        + '" text-anchor="middle">' + t + '</text>'
      : ''
    ).join('');

    return '<svg viewBox="0 0 ' + VB.w + ' ' + VB.h + '" class="chart" role="img" aria-label="'
      + data.sub + '">' + grid
      + '<line class="axis" x1="' + VB.padL + '" y1="' + base + '" x2="' + (VB.w - VB.padR) + '" y2="' + base + '"/>'
      + barras + ejeX + '</svg>';
  }

  /* ---------- tabla de datos (respaldo accesible) ---------- */

  function tablaFor(data) {
    const filas = data.values
      .map((v, i) => ({ v: v, i: i }))
      .filter((r) => r.v > 0)
      .map((r) => '<tr><th scope="row">' + data.detalle(r.i) + '</th><td>' + dur(r.v) + '</td></tr>')
      .join('');
    if (!filas) return '<p class="empty-mini">Sin registros en este periodo.</p>';
    return '<table class="dtable"><thead><tr><th scope="col">Periodo</th>'
      + '<th scope="col">Foco</th></tr></thead><tbody>' + filas + '</tbody></table>';
  }

  function unidad(n) {
    if (range === 'hour') return n === 1 ? 'hora' : 'horas';
    if (range === 'weekday') return n === 1 ? 'día' : 'días';
    return n === 1 ? 'semana' : 'semanas';
  }

  /* ---------- render ---------- */

  function render() {
    const host = document.getElementById('viewStats');
    if (!host || host.hidden) return;

    const data = build();
    const total = data.values.reduce((a, b) => a + b, 0);

    document.getElementById('periodLabel').textContent = data.label;
    document.getElementById('nextBtn').disabled = !puedeAvanzar();
    document.getElementById('chartSub').textContent = data.sub;

    document.getElementById('heroTotal').textContent = total > 0 ? dur(total) : '—';
    const activos = data.values.filter((v) => v > 0).length;
    document.getElementById('heroSub').textContent = total > 0
      ? 'repartido en ' + activos + ' ' + unidad(activos)
      : 'Sin tiempo de foco registrado';

    document.getElementById('chartHost').innerHTML = total > 0
      ? svgFor(data)
      : '<p class="empty">Nada todavía.<br><span>Completa un bloque de foco y aparecerá aquí.</span></p>';

    const det = document.getElementById('barDetail');
    if (selected >= 0 && data.values[selected] > 0) {
      det.innerHTML = '<span class="det-val">' + dur(data.values[selected]) + '</span>'
        + '<span class="det-lab">' + data.detalle(selected) + '</span>';
      det.hidden = false;
    } else {
      det.hidden = true;
    }

    document.getElementById('tableHost').innerHTML = tablaFor(data);
  }

  /* ---------- eventos ---------- */

  function init() {
    const seg = document.getElementById('rangeSeg');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      range = b.dataset.range;
      cursor = Date.now();
      selected = -1;
      for (const s of seg.children) s.classList.toggle('is-active', s === b);
      render();
    });

    document.getElementById('prevBtn').addEventListener('click', () => mover(-1));
    document.getElementById('nextBtn').addEventListener('click', () => mover(1));

    document.getElementById('chartHost').addEventListener('click', (e) => {
      const hit = e.target.closest('.hit');
      if (!hit) return;
      const i = Number(hit.dataset.i);
      selected = selected === i ? -1 : i;
      render();
    });
  }

  return {
    init: init,
    render: render,
    reset: () => { cursor = Date.now(); selected = -1; },
    _dur: dur,
    _niceMax: niceMax,
  };
})();
