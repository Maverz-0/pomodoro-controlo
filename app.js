/* Pomodoro — base
   El temporizador se basa en marcas de tiempo (Date.now), no en contar ticks,
   para que siga siendo exacto si iOS congela la pestaña en segundo plano. */

const DURATIONS = {
  focus: 25 * 60,
  short: 5 * 60,
  long:  15 * 60,
};
const ROUNDS_BEFORE_LONG = 4;
const STORE_KEY = 'pomodoro.state.v1';

const el = {
  modes:    document.getElementById('modes'),
  time:     document.getElementById('time'),
  round:    document.getElementById('round'),
  ring:     document.getElementById('ringProgress'),
  startBtn: document.getElementById('startBtn'),
  resetBtn: document.getElementById('resetBtn'),
  skipBtn:  document.getElementById('skipBtn'),
  status:   document.getElementById('status'),
  notifBtn: document.getElementById('notifBtn'),
};

const RING_LEN = 2 * Math.PI * 108;

let state = {
  mode: 'focus',
  running: false,
  endAt: null,        // timestamp ms en que acaba, si running
  remaining: DURATIONS.focus, // segundos restantes, si pausado
  round: 1,           // ronda de foco actual
  completed: 0,       // pomodoros de foco completados
};

let rafId = null;

/* ---------- persistencia ---------- */

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && typeof s === 'object' && DURATIONS[s.mode]) state = { ...state, ...s };
  } catch {}
}

/* ---------- lógica ---------- */

function secondsLeft() {
  if (!state.running) return state.remaining;
  return Math.max(0, Math.round((state.endAt - Date.now()) / 1000));
}

function start() {
  if (state.running) return;
  state.endAt = Date.now() + state.remaining * 1000;
  state.running = true;
  unlockAudio();
  // Solo el modo foco cuenta como tiempo de foco.
  if (state.mode === 'focus') Stats.begin(state.endAt);
  save();
  render();
  loop();
  Push.schedule(state.endAt, state.mode);
}

function pause() {
  if (!state.running) return;
  state.remaining = secondsLeft();
  state.running = false;
  state.endAt = null;
  Stats.close(Date.now());
  cancelAnimationFrame(rafId);
  save();
  render();
  Push.cancel();
}

function reset() {
  Stats.close(Date.now());
  state.running = false;
  state.endAt = null;
  state.remaining = DURATIONS[state.mode];
  cancelAnimationFrame(rafId);
  save();
  render();
  Push.cancel();
}

function setMode(mode, { keepStats = true } = {}) {
  if (!DURATIONS[mode]) return;
  Stats.close(Date.now());
  state.mode = mode;
  state.running = false;
  state.endAt = null;
  state.remaining = DURATIONS[mode];
  if (!keepStats) { state.round = 1; state.completed = 0; }
  cancelAnimationFrame(rafId);
  save();
  render();
  Push.cancel();
}

/* Avanza al siguiente bloque. `natural` = el temporizador llegó a cero. */
function advance(natural) {
  if (state.mode === 'focus') {
    if (natural) state.completed++;
    const next = state.completed > 0 && state.completed % ROUNDS_BEFORE_LONG === 0
      ? 'long' : 'short';
    setMode(next);
  } else {
    if (state.mode === 'long') state.round = 1;
    else state.round++;
    setMode('focus');
  }
}

function complete() {
  cancelAnimationFrame(rafId);
  // Cierra el foco en el instante exacto en que vencía, no cuando lo detectamos.
  Stats.close(state.endAt || Date.now());
  state.running = false;
  state.endAt = null;
  notify();
  advance(true);
  el.status.textContent = 'Bloque completado';
}

/* ---------- bucle de render ---------- */

function loop() {
  const left = secondsLeft();
  if (left <= 0) { complete(); return; }
  render();
  rafId = requestAnimationFrame(loop);
}

function fmt(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function render() {
  const left = secondsLeft();
  const total = DURATIONS[state.mode];

  el.time.textContent = fmt(left);
  document.title = `${fmt(left)} · Pomodoro Controlo`;
  document.body.dataset.mode = state.mode;

  el.ring.style.strokeDashoffset = RING_LEN * (1 - left / total);

  el.startBtn.textContent = state.running ? 'Pausar' : (left < total ? 'Reanudar' : 'Empezar');
  el.round.textContent = `Ronda ${state.round} · ${state.completed} completados`;

  for (const b of el.modes.children) {
    b.classList.toggle('is-active', b.dataset.mode === state.mode);
  }
}

/* ---------- aviso: sonido + vibración ---------- */

let audioCtx = null;

function unlockAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [0, 0.22, 0.44].forEach((offset) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(0.3, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.2);
  });
}

function notify() {
  beep();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

/* ---------- UI de avisos ---------- */

const NOTIF_UI = {
  'not-installed': { show: false, msg: 'Añade la app a la pantalla de inicio para recibir avisos' },
  'unsupported':   { show: false, msg: 'Este navegador no admite avisos en segundo plano' },
  'default':       { show: true,  label: '🔔 Activar avisos', msg: 'Listo' },
  'denied':        { show: false, msg: 'Avisos bloqueados — actívalos en Ajustes › Notificaciones' },
  'granted':       { show: false, msg: 'Avisos activados' },
};

function renderNotifUI(override) {
  const s = override || Push.status();
  const ui = NOTIF_UI[s] || NOTIF_UI.default;
  el.notifBtn.hidden = !ui.show;
  if (ui.label) el.notifBtn.textContent = ui.label;
  el.status.textContent = ui.msg;
}

el.notifBtn.addEventListener('click', async () => {
  el.notifBtn.disabled = true;
  el.status.textContent = 'Pidiendo permiso…';
  try {
    await Push.enable();
    renderNotifUI('granted');
    // Si ya había un bloque corriendo, prográmalo ahora que hay suscripción.
    if (state.running) Push.schedule(state.endAt, state.mode);
  } catch (err) {
    el.status.textContent = err.message;
  } finally {
    el.notifBtn.disabled = false;
  }
});

/* ---------- eventos ---------- */

el.startBtn.addEventListener('click', () => (state.running ? pause() : start()));
el.resetBtn.addEventListener('click', reset);
el.skipBtn.addEventListener('click', () => advance(false));

el.modes.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode');
  if (btn) setMode(btn.dataset.mode);
});

// Al volver del segundo plano, recalcular por si el rAF quedó congelado.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.running) {
    if (secondsLeft() <= 0) complete();
    else { cancelAnimationFrame(rafId); loop(); }
  } else {
    render();
  }
});

/* ---------- Pestañas ---------- */

function showView(name) {
  document.getElementById('viewTimer').hidden = name !== 'timer';
  document.getElementById('viewStats').hidden = name !== 'stats';
  for (const t of document.getElementById('tabbar').children) {
    t.classList.toggle('is-active', t.dataset.view === name);
  }
  if (name === 'stats') Charts.render();
}

document.getElementById('tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) showView(t.dataset.view);
});

/* ---------- Aviso de nueva versión ---------- */

let recargando = false;

function ofrecerActualizacion(reg) {
  const bar = document.getElementById('updateBar');
  bar.hidden = false;
  document.getElementById('updateBtn').onclick = () => {
    // El nuevo service worker espera a que se lo pidamos para tomar el relevo.
    if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    bar.hidden = true;
  };
}

function vigilarActualizaciones(reg) {
  if (reg.waiting && navigator.serviceWorker.controller) ofrecerActualizacion(reg);

  reg.addEventListener('updatefound', () => {
    const nuevo = reg.installing;
    if (!nuevo) return;
    nuevo.addEventListener('statechange', () => {
      // Sin controller es la primera instalación: no hay nada que "actualizar".
      if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
        ofrecerActualizacion(reg);
      }
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recargando) return;
    recargando = true;
    location.reload();
  });

  // Busca versiones nuevas al volver a la app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
}

/* ---------- arranque ---------- */

load();
// Si la app murió con un bloque de foco corriendo, ciérralo donde tocaba.
Stats.reconcile(state.running);
Charts.init();

if (state.running && secondsLeft() <= 0) {
  // Se cumplió mientras la app estaba cerrada.
  state.running = false;
  state.endAt = null;
  advance(true);
} else {
  render();
  if (state.running) loop();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => { renderNotifUI(); vigilarActualizaciones(reg); })
      .catch(() => renderNotifUI());
  });
} else {
  renderNotifUI();
}
