"use strict";

/*
  HIIT Timer
  - Fases: WARMUP -> (WORK <-> REST1/REST2) -> COOLDOWN -> DONE
  - REST2 é opcional e pode acontecer a cada N rounds (rest2Every).
  - Persistência: salva config em localStorage.
  - Timer robusto: usa timestamp (continua correto mesmo em background).
  - Áudio robusto iPhone: reusa AudioContext + master gain + resume no Start.
*/

const STORAGE_KEY = "hiit_config_v1";

// ===== Helpers de erro visível (sem console) =====
function showFatal(msg) {
  try {
    const el = document.getElementById("next");
    if (el) el.textContent = `Erro: ${msg}`;
  } catch {}
}

window.addEventListener("error", (e) => {
  const m = e?.message || "Erro desconhecido";
  showFatal(m);
});
window.addEventListener("unhandledrejection", (e) => {
  const m = e?.reason?.message || String(e?.reason || "Promise rejection");
  showFatal(m);
});

// ===== Elements (com validação) =====
function mustGet(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento não encontrado: #${id}`);
  return el;
}

let elWarmup, elRounds, elWork, elRest1, elRest2, elRest2Every, elCooldown, elSound, elVibrate;
let btnStart, btnPause, btnReset;
let outPhase, outRound, outTime, outNext, barFill;

try {
  elWarmup = mustGet("warmup");
  elRounds = mustGet("rounds");
  elWork = mustGet("work");
  elRest1 = mustGet("rest1");
  elRest2 = mustGet("rest2");
  elRest2Every = mustGet("rest2Every");
  elCooldown = mustGet("cooldown");
  elSound = mustGet("sound");
  elVibrate = mustGet("vibrate");

  btnStart = mustGet("btnStart");
  btnPause = mustGet("btnPause");
  btnReset = mustGet("btnReset");

  outPhase = mustGet("phase");
  outRound = mustGet("round");
  outTime = mustGet("time");
  outNext = mustGet("next");
  barFill = mustGet("barFill");
} catch (err) {
  showFatal(err.message);
  throw err; // para não continuar quebrado silenciosamente
}

// ===== Timer state =====
let timerId = null;
let running = false;
let paused = false;

// Timestamp-based timing
let phaseEndAt = 0; // ms timestamp quando a fase atual termina

// Sequence state
let phase = "IDLE"; // IDLE, WARMUP, WORK, REST1, REST2, COOLDOWN, DONE
let totalRounds = 20;
let currentRound = 0; // 1..totalRounds
let remaining = 0; // seconds remaining in current phase
let phaseDuration = 0; // seconds total for current phase (for progress bar)

// Config congelada durante execução
let cfgRun = null;

// =========================
// AUDIO (iPhone-friendly)
// =========================
let audioCtx = null;
let masterGain = null;

function initAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  if (!audioCtx) {
    audioCtx = new AudioCtx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.35; // master volume (0.25 a 0.60)
    masterGain.connect(audioCtx.destination);
  }

  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

// Load saved config
loadConfig();
renderIdle();

// Events
btnStart.addEventListener("click", () => {
  try { start(); } catch (e) { showFatal(e.message || String(e)); }
});
btnPause.addEventListener("click", () => {
  try { togglePause(); } catch (e) { showFatal(e.message || String(e)); }
});
btnReset.addEventListener("click", () => {
  try { resetAll(); } catch (e) { showFatal(e.message || String(e)); }
});

// Salva config somente quando NÃO está rodando (evita sujar config do treino)
[
  elWarmup, elRounds, elWork, elRest1, elRest2, elRest2Every, elCooldown, elSound, elVibrate
].forEach(el => el.addEventListener("change", () => {
  if (running) return;
  saveConfig();
}));

function setInputsDisabled(disabled) {
  [
    elWarmup, elRounds, elWork, elRest1, elRest2, elRest2Every, elCooldown, elSound, elVibrate
  ].forEach(el => { el.disabled = disabled; });
}

function start() {
  if (running) return;

  const cfg = readConfigFromUI();
  if (!cfg.ok) {
    alert(cfg.error);
    return;
  }

  initAudio();        // garante áudio no iPhone
  cfgRun = cfg.value; // congela config do treino
  applyConfig(cfgRun);

  setInputsDisabled(true);

  // inicia na fase WARMUP (se 0, pula direto para WORK)
  phase = (cfgRun.warmup > 0) ? "WARMUP" : "WORK";
  currentRound = 0;

  paused = false;
  enterPhase(phase);

  setButtonsRunning(true);
  running = true;

  tickLoop();
}

function togglePause() {
  if (!running) return;

  if (!paused) {
    paused = true;

    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }

    remaining = Math.max(0, Math.ceil((phaseEndAt - Date.now()) / 1000));
    btnPause.textContent = "Continuar";
    outNext.textContent = "Pausado.";
    render();
    return;
  }

  paused = false;
  btnPause.textContent = "Pausar";
  phaseEndAt = Date.now() + remaining * 1000;
  tickLoop();
}

function resetAll() {
  stopTimer();
  running = false;
  paused = false;
  phaseEndAt = 0;

  phase = "IDLE";
  currentRound = 0;
  remaining = 0;
  phaseDuration = 0;
  cfgRun = null;

  setInputsDisabled(false);
  setButtonsRunning(false);
  renderIdle();
}

function tickLoop() {
  syncRemainingFromClock();
  render();

  if (timerId) clearInterval(timerId);

  timerId = setInterval(() => {
    if (!running || paused) return;

    const prev = remaining;
    syncRemainingFromClock();

    if (remaining > 0 && remaining <= 3 && remaining !== prev) signal();

    while (remaining <= 0 && running && !paused) {
      nextPhase();
      if (phase === "DONE") return;
      syncRemainingFromClock();
    }

    render();
  }, 250);
}

function syncRemainingFromClock() {
  if (phase === "IDLE" || phase === "DONE") {
    remaining = 0;
    return;
  }
  remaining = Math.max(0, Math.ceil((phaseEndAt - Date.now()) / 1000));
}

function nextPhase() {
  if (phase === "WARMUP") {
    phase = "WORK";
    enterPhase(phase);
    return;
  }

  if (phase === "WORK") {
    if (currentRound >= totalRounds) {
      phase = (getCfg().cooldown > 0) ? "COOLDOWN" : "DONE";
      enterPhase(phase);
      return;
    }

    const cfg = getCfg();
    const shouldRest2 =
      cfg.rest2 > 0 &&
      cfg.rest2Every > 0 &&
      (currentRound % cfg.rest2Every === 0);

    if (shouldRest2) {
      phase = "REST2";
      enterPhase(phase);
      return;
    }

    if (cfg.rest1 > 0) {
      phase = "REST1";
      enterPhase(phase);
      return;
    }

    phase = "WORK";
    enterPhase(phase);
    return;
  }

  if (phase === "REST1" || phase === "REST2") {
    phase = "WORK";
    enterPhase(phase);
    return;
  }

  if (phase === "COOLDOWN") {
    phase = "DONE";
    enterPhase(phase);
    return;
  }

  if (phase === "DONE") {
    stopTimer();
    running = false;
    paused = false;
    setInputsDisabled(false);
    setButtonsRunning(false);
    renderDone();
  }
}

function enterPhase(newPhase) {
  phase = newPhase;

  if (phase === "WORK") {
    currentRound += 1;
    remaining = getCfg().work;
    phaseDuration = remaining;
    phaseEndAt = Date.now() + remaining * 1000;
    signalStrong();
    return;
  }

  if (phase === "WARMUP") {
    remaining = getCfg().warmup;
    phaseDuration = remaining;
    phaseEndAt = Date.now() + remaining * 1000;
    signalStrong();
    return;
  }

  if (phase === "REST1") {
    remaining = getCfg().rest1;
    phaseDuration = remaining;
    phaseEndAt = Date.now() + remaining * 1000;
    signalStrong();
    return;
  }

  if (phase === "REST2") {
    remaining = getCfg().rest2;
    phaseDuration = remaining;
    phaseEndAt = Date.now() + remaining * 1000;
    signalStrong();
    return;
  }

  if (phase === "COOLDOWN") {
    remaining = getCfg().cooldown;
    phaseDuration = remaining;
    phaseEndAt = Date.now() + remaining * 1000;
    signalStrong();
    return;
  }

  if (phase === "DONE") {
    remaining = 0;
    phaseDuration = 0;
    phaseEndAt = 0;
    signalStrong();

    stopTimer();
    running = false;
    paused = false;
    setInputsDisabled(false);
    setButtonsRunning(false);
    renderDone();
  }
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  paused = false;
  btnPause.textContent = "Pausar";
}

function setButtonsRunning(isRunning) {
  btnStart.disabled = isRunning;
  btnPause.disabled = !isRunning;
  btnReset.disabled = !isRunning;
}

function renderIdle() {
  outPhase.textContent = "—";
  outRound.textContent = "—";
  outTime.textContent = "00:00";
  outNext.textContent = "Ajuste os tempos e clique em Iniciar.";
  barFill.style.width = "0%";
}

function renderDone() {
  outPhase.textContent = "Finalizado";
  outRound.textContent = `${totalRounds}/${totalRounds}`;
  outTime.textContent = "00:00";
  outNext.textContent = "Treino concluído.";
  barFill.style.width = "0%";
}

function render() {
  outPhase.textContent = phaseLabel(phase);
  outRound.textContent =
    (phase === "IDLE" || phase === "WARMUP" || phase === "COOLDOWN" || phase === "DONE")
      ? `${Math.min(currentRound, totalRounds)}/${totalRounds}`
      : `${currentRound}/${totalRounds}`;

  outTime.textContent = formatMMSS(remaining);

  const pct = (phaseDuration > 0)
    ? Math.max(0, Math.min(100, ((phaseDuration - remaining) / phaseDuration) * 100))
    : 0;
  barFill.style.width = `${pct}%`;

  outNext.textContent = buildNextText();
}

function buildNextText() {
  const cfg = getCfg();

  if (phase === "WARMUP") return "Próximo: Trabalho (round 1).";
  if (phase === "WORK") {
    if (currentRound >= totalRounds) {
      return (cfg.cooldown > 0) ? "Próximo: Término / Cooldown." : "Próximo: Finalizar.";
    }

    const shouldRest2 = cfg.rest2 > 0 && cfg.rest2Every > 0 && (currentRound % cfg.rest2Every === 0);
    if (shouldRest2) return `Próximo: Intervalo longo (${cfg.rest2}s).`;
    if (cfg.rest1 > 0) return `Próximo: Intervalo curto (${cfg.rest1}s).`;
    return `Próximo: Trabalho (round ${currentRound + 1}).`;
  }
  if (phase === "REST1" || phase === "REST2") return `Próximo: Trabalho (round ${currentRound + 1}).`;
  if (phase === "COOLDOWN") return "Próximo: Finalizar.";
  if (phase === "DONE") return "Treino concluído.";
  return "Pronto para iniciar.";
}

function phaseLabel(p) {
  switch (p) {
    case "WARMUP": return "Aquecimento";
    case "WORK": return "Trabalho";
    case "REST1": return "Intervalo curto";
    case "REST2": return "Intervalo longo";
    case "COOLDOWN": return "Término / Cooldown";
    case "DONE": return "Finalizado";
    default: return "—";
  }
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, totalSeconds | 0);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function signal() {
  const cfg = getCfg();
  if (cfg.sound) beep(0.04, 1050);
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate(40);
}

function signalStrong() {
  const cfg = getCfg();
  if (cfg.sound) {
    beep(0.08, 900);
    setTimeout(() => beep(0.08, 1250), 90);
  }
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate([70, 40, 70]);
}

function beep(durationSec, frequency) {
  try {
    initAudio();
    if (!audioCtx || !masterGain) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.value = frequency;

    const now = audioCtx.currentTime;
    const attack = 0.008;
    const release = Math.max(0.02, durationSec);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.8, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + release);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(now);
    osc.stop(now + release + 0.02);
  } catch {
    // ignore
  }
}

/* Config helpers */
function readConfigFromUI() {
  const value = {
    warmup: toInt(elWarmup.value, 0),
    rounds: toInt(elRounds.value, 20),
    work: toInt(elWork.value, 40),
    rest1: toInt(elRest1.value, 20),
    rest2: toInt(elRest2.value, 0),
    rest2Every: toInt(elRest2Every.value, 0),
    cooldown: toInt(elCooldown.value, 0),
    sound: !!elSound.checked,
    vibrate: !!elVibrate.checked
  };

  if (value.rounds < 1) return { ok: false, error: "Rounds deve ser >= 1" };
  if (value.work < 1) return { ok: false, error: "Trabalho deve ser >= 1" };
  if (value.warmup < 0 || value.rest1 < 0 || value.rest2 < 0 || value.cooldown < 0) {
    return { ok: false, error: "Tempos não podem ser negativos." };
  }
  if (value.rest2Every < 0) return { ok: false, error: "rest2Every não pode ser negativo." };

  return { ok: true, value };
}

function applyConfig(cfg) {
  totalRounds = cfg.rounds;
}

function getCfg() {
  if (running && cfgRun) return cfgRun;
  return readConfigFromUI().value;
}

function toInt(v, fallback) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function saveConfig() {
  const cfg = readConfigFromUI();
  if (!cfg.ok) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg.value));
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw);

    if (typeof cfg.warmup === "number") elWarmup.value = cfg.warmup;
    if (typeof cfg.rounds === "number") elRounds.value = cfg.rounds;
    if (typeof cfg.work === "number") elWork.value = cfg.work;
    if (typeof cfg.rest1 === "number") elRest1.value = cfg.rest1;
    if (typeof cfg.rest2 === "number") elRest2.value = cfg.rest2;
    if (typeof cfg.rest2Every === "number") elRest2Every.value = cfg.rest2Every;
    if (typeof cfg.cooldown === "number") elCooldown.value = cfg.cooldown;
    if (typeof cfg.sound === "boolean") elSound.checked = cfg.sound;
    if (typeof cfg.vibrate === "boolean") elVibrate.checked = cfg.vibrate;
  } catch {
    // ignore
  }
}
