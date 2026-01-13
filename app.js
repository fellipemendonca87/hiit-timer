"use strict";

/*
  HIIT Timer
  - Fases: WARMUP -> (WORK <-> REST1/REST2) -> COOLDOWN -> DONE
  - REST2 é opcional e pode acontecer a cada N rounds (rest2Every).
  - Persistência: salva config em localStorage.
*/

const STORAGE_KEY = "hiit_config_v1";

// Elements
const elWarmup = document.getElementById("warmup");
const elRounds = document.getElementById("rounds");
const elWork = document.getElementById("work");
const elRest1 = document.getElementById("rest1");
const elRest2 = document.getElementById("rest2");
const elRest2Every = document.getElementById("rest2Every");
const elCooldown = document.getElementById("cooldown");
const elSound = document.getElementById("sound");
const elVibrate = document.getElementById("vibrate");

const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnReset = document.getElementById("btnReset");

const outPhase = document.getElementById("phase");
const outRound = document.getElementById("round");
const outTime = document.getElementById("time");
const outNext = document.getElementById("next");
const barFill = document.getElementById("barFill");

// Timer state
let timerId = null;
let running = false;

// Sequence state
let phase = "IDLE"; // IDLE, WARMUP, WORK, REST1, REST2, COOLDOWN, DONE
let totalRounds = 20;
let currentRound = 0; // 1..totalRounds
let remaining = 0; // seconds remaining in current phase
let phaseDuration = 0; // seconds total for current phase (for progress bar)

// Load saved config
loadConfig();
renderIdle();

// Events
btnStart.addEventListener("click", start);
btnPause.addEventListener("click", togglePause);
btnReset.addEventListener("click", resetAll);

[
  elWarmup, elRounds, elWork, elRest1, elRest2, elRest2Every, elCooldown, elSound, elVibrate
].forEach(el => el.addEventListener("change", saveConfig));

function start() {
  if (running) return;

  const cfg = readConfigFromUI();
  if (!cfg.ok) {
    alert(cfg.error);
    return;
  }

  applyConfig(cfg.value);

  // inicia na fase WARMUP (se 0, pula direto para WORK)
  phase = (cfg.value.warmup > 0) ? "WARMUP" : "WORK";
  currentRound = 0;

  enterPhase(phase);
  setButtonsRunning(true);
  running = true;

  tickLoop();
}

function togglePause() {
  if (!running) return;

  if (timerId) {
    clearInterval(timerId);
    timerId = null;
    btnPause.textContent = "Continuar";
    outNext.textContent = "Pausado.";
  } else {
    btnPause.textContent = "Pausar";
    tickLoop();
  }
}

function resetAll() {
  stopTimer();
  running = false;
  phase = "IDLE";
  currentRound = 0;
  remaining = 0;
  phaseDuration = 0;
  setButtonsRunning(false);
  renderIdle();
}

function tickLoop() {
  // Tick imediato para refletir UI no instante do start/continue
  render();

  timerId = setInterval(() => {
    if (remaining <= 0) {
      nextPhase();
      render();
      return;
    }

    // últimos 3 segundos: sinal
    if (remaining <= 3) signal();

    remaining -= 1;
    render();
  }, 1000);
}

function nextPhase() {
  // Ao encerrar WARMUP, entra em WORK round 1
  if (phase === "WARMUP") {
    phase = "WORK";
    enterPhase(phase);
    return;
  }

  // WORK -> REST (se houver) ou próximo WORK
  if (phase === "WORK") {
    // terminou um round
    if (currentRound >= totalRounds) {
      // acabou todos os rounds -> COOLDOWN (se 0, DONE)
      phase = (getCfg().cooldown > 0) ? "COOLDOWN" : "DONE";
      enterPhase(phase);
      return;
    }

    // decide REST2 (longo) ou REST1 (curto) ou sem descanso
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

    // sem descanso: próximo WORK
    phase = "WORK";
    enterPhase(phase);
    return;
  }

  // REST1/REST2 -> WORK (próximo round)
  if (phase === "REST1" || phase === "REST2") {
    phase = "WORK";
    enterPhase(phase);
    return;
  }

  // COOLDOWN -> DONE
  if (phase === "COOLDOWN") {
    phase = "DONE";
    enterPhase(phase);
    return;
  }

  // DONE: para tudo
  if (phase === "DONE") {
    stopTimer();
    running = false;
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
    signalStrong();
    return;
  }

  if (phase === "WARMUP") {
    remaining = getCfg().warmup;
    phaseDuration = remaining;
    signalStrong();
    return;
  }

  if (phase === "REST1") {
    remaining = getCfg().rest1;
    phaseDuration = remaining;
    signalStrong();
    return;
  }

  if (phase === "REST2") {
    remaining = getCfg().rest2;
    phaseDuration = remaining;
    signalStrong();
    return;
  }

  if (phase === "COOLDOWN") {
    remaining = getCfg().cooldown;
    phaseDuration = remaining;
    signalStrong();
    return;
  }

  if (phase === "DONE") {
    remaining = 0;
    phaseDuration = 0;
    signalStrong();
  }
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
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
  outRound.textContent = (phase === "IDLE" || phase === "WARMUP" || phase === "COOLDOWN" || phase === "DONE")
    ? `${Math.min(currentRound, totalRounds)}/${totalRounds}`
    : `${currentRound}/${totalRounds}`;

  outTime.textContent = formatMMSS(remaining);

  // Progress
  const pct = (phaseDuration > 0) ? Math.max(0, Math.min(100, ((phaseDuration - remaining) / phaseDuration) * 100)) : 0;
  barFill.style.width = `${pct}%`;

  // Próximo
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
  if (cfg.sound) beep(0.03, 720);
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate(40);
}

function signalStrong() {
  const cfg = getCfg();
  if (cfg.sound) {
    beep(0.06, 520);
    setTimeout(() => beep(0.06, 820), 90);
  }
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate([60, 40, 60]);
}

/* Beep com WebAudio (sem dependências) */
function beep(durationSec, frequency) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = frequency;

    gain.gain.value = 0.001;
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, Math.ceil(durationSec * 1000) + 40);
  } catch {
    // sem áudio (navegador pode bloquear sem interação)
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

  if (value.rounds < 1) return { ok:false, error:"Rounds deve ser >= 1" };
  if (value.work < 1) return { ok:false, error:"Trabalho deve ser >= 1" };
  if (value.warmup < 0 || value.rest1 < 0 || value.rest2 < 0 || value.cooldown < 0) {
    return { ok:false, error:"Tempos não podem ser negativos." };
  }
  if (value.rest2Every < 0) return { ok:false, error:"rest2Every não pode ser negativo." };

  return { ok:true, value };
}

function applyConfig(cfg) {
  totalRounds = cfg.rounds;
}

function getCfg() {
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
    // ignora config inválida
  }
}
