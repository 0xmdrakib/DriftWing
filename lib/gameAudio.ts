"use client";

export type GameAudioPhase = "menu" | "play" | "over";
export type GameSoundEffect =
  | "hit"
  | "destroy"
  | "gameover"
  | "powerup"
  | "start";

export type GameAudioPreferences = {
  musicEnabled: boolean;
  sfxEnabled: boolean;
};

const MUSIC_STORAGE_KEY = "driftwing.audio.music";
const SFX_STORAGE_KEY = "driftwing.audio.sfx";

const BPM = 112;
const SIXTEENTH_SECONDS = 60 / BPM / 4;
const STEPS_PER_BAR = 16;
const LOOP_BARS = 8;
const LOOP_STEPS = STEPS_PER_BAR * LOOP_BARS;
const SCHEDULE_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;

const CHORDS = [
  [50, 53, 57, 64], // Dm(add9)
  [46, 50, 53, 57], // Bbmaj7
  [41, 45, 48, 55], // F(add9)
  [48, 52, 55, 62], // C(add9)
  [50, 53, 57, 64],
  [46, 50, 53, 57],
  [48, 52, 55, 62],
  [50, 53, 57, 64],
] as const;

const MENU_MOTIF = [74, 77, 81, 76, 74, 72, 69, 72] as const;

let context: AudioContext | null = null;
let compressor: DynamicsCompressorNode | null = null;
let musicBus: GainNode | null = null;
let musicDuckBus: GainNode | null = null;
let sfxBus: GainNode | null = null;

let currentPhase: GameAudioPhase = "menu";
let unlocked = false;
let schedulerId: number | null = null;
let nextStepTime = 0;
let sequenceStep = 0;
let visibilityHandler: (() => void) | null = null;
let preferencesLoaded = false;
let preferences: GameAudioPreferences = {
  musicEnabled: true,
  sfxEnabled: true,
};

const activeSources = new Set<AudioScheduledSourceNode>();

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    // Storage can be unavailable in privacy-restricted webviews.
  }
  return fallback;
}

function loadPreferences() {
  if (preferencesLoaded) return;
  preferencesLoaded = true;
  preferences = {
    musicEnabled: readStoredBoolean(MUSIC_STORAGE_KEY, true),
    sfxEnabled: readStoredBoolean(SFX_STORAGE_KEY, true),
  };
}

function persistPreference(key: string, enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, enabled ? "1" : "0");
  } catch {
    // Preferences remain active for this session when storage is unavailable.
  }
}

function midiToFrequency(note: number) {
  return 440 * 2 ** ((note - 69) / 12);
}

function trackSource(source: AudioScheduledSourceNode) {
  activeSources.add(source);
  source.addEventListener(
    "ended",
    () => {
      activeSources.delete(source);
    },
    { once: true }
  );
}

function ensureAudioGraph() {
  if (context && context.state !== "closed") return context;
  if (typeof window === "undefined") return null;

  const AudioContextConstructor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) return null;

  const ctx = new AudioContextConstructor();
  const nextCompressor = ctx.createDynamicsCompressor();
  const nextMusicBus = ctx.createGain();
  const nextMusicDuckBus = ctx.createGain();
  const nextSfxBus = ctx.createGain();

  nextCompressor.threshold.value = -16;
  nextCompressor.knee.value = 18;
  nextCompressor.ratio.value = 4;
  nextCompressor.attack.value = 0.004;
  nextCompressor.release.value = 0.22;

  nextMusicBus.gain.value = 0.0001;
  nextMusicDuckBus.gain.value = 1;
  nextSfxBus.gain.value = 1.05;
  nextMusicBus.connect(nextMusicDuckBus);
  nextMusicDuckBus.connect(nextCompressor);
  nextSfxBus.connect(nextCompressor);
  nextCompressor.connect(ctx.destination);

  context = ctx;
  compressor = nextCompressor;
  musicBus = nextMusicBus;
  musicDuckBus = nextMusicDuckBus;
  sfxBus = nextSfxBus;

  visibilityHandler = () => {
    if (!context || !unlocked) return;
    if (document.visibilityState === "hidden") {
      void context.suspend();
      return;
    }

    void context.resume().then(() => {
      resetTimeline();
      applyPhaseGain(0.28);
    });
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  return ctx;
}

function phaseGain() {
  if (!preferences.musicEnabled || currentPhase === "over") return 0.0001;
  return currentPhase === "play" ? 0.96 : 0.58;
}

function rampGain(param: AudioParam, target: number, duration: number) {
  if (!context) return;
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(0.0001, param.value), now);
  param.exponentialRampToValueAtTime(Math.max(0.0001, target), now + duration);
}

function applyPhaseGain(duration: number) {
  if (!musicBus) return;
  rampGain(musicBus.gain, phaseGain(), duration);
}

function duckMusicForEffect(type: GameSoundEffect) {
  if (!context || !musicDuckBus || !preferences.musicEnabled) return;
  const now = context.currentTime;
  const isHit = type === "hit";
  const isDestroy = type === "destroy" || type === "gameover";
  const duckTo = isHit ? 0.7 : isDestroy ? 0.42 : 0.55;
  const recoverAt = isHit ? 0.12 : isDestroy ? 0.28 : 0.22;

  musicDuckBus.gain.cancelScheduledValues(now);
  musicDuckBus.gain.setValueAtTime(
    Math.max(0.0001, musicDuckBus.gain.value),
    now
  );
  musicDuckBus.gain.exponentialRampToValueAtTime(duckTo, now + 0.008);
  musicDuckBus.gain.exponentialRampToValueAtTime(1, now + recoverAt);
}

function scheduleOscillator(
  frequency: number,
  start: number,
  duration: number,
  volume: number,
  type: OscillatorType,
  destination: AudioNode,
  filterFrequency?: number,
  detune = 0
) {
  if (!context) return;
  const osc = context.createOscillator();
  const gain = context.createGain();
  const filter = filterFrequency ? context.createBiquadFilter() : null;

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  osc.detune.setValueAtTime(detune, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.025, duration * 0.2));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  if (filter) {
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(filterFrequency || 1200, start);
    filter.Q.value = 0.8;
    osc.connect(filter);
    filter.connect(gain);
  } else {
    osc.connect(gain);
  }
  gain.connect(destination);

  trackSource(osc);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function schedulePad(chord: readonly number[], start: number, menu: boolean) {
  if (!context || !musicBus) return;
  const duration = SIXTEENTH_SECONDS * STEPS_PER_BAR * 0.98;
  const level = menu ? 0.009 : 0.0065;

  chord.forEach((note, index) => {
    const frequency = midiToFrequency(note);
    scheduleOscillator(
      frequency,
      start,
      duration,
      level,
      "triangle",
      musicBus!,
      menu ? 920 : 760,
      index % 2 === 0 ? -7 : 7
    );
  });
}

function scheduleBell(note: number, start: number, level = 0.018) {
  if (!musicBus) return;
  const frequency = midiToFrequency(note);
  scheduleOscillator(frequency, start, 0.34, level, "sine", musicBus, 2800);
  scheduleOscillator(frequency * 2, start, 0.2, level * 0.22, "sine", musicBus, 3600);
}

function scheduleBass(note: number, start: number, accent: boolean) {
  if (!musicBus) return;
  scheduleOscillator(
    midiToFrequency(note),
    start,
    SIXTEENTH_SECONDS * 1.75,
    accent ? 0.038 : 0.027,
    "sawtooth",
    musicBus,
    420
  );
}

function scheduleKick(start: number, accent: boolean) {
  if (!context || !musicBus) return;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(accent ? 96 : 84, start);
  osc.frequency.exponentialRampToValueAtTime(50, start + 0.12);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.052 : 0.038, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
  osc.connect(gain);
  gain.connect(musicBus);
  trackSource(osc);
  osc.start(start);
  osc.stop(start + 0.15);
}

function scheduleSoftPercussion(start: number, kind: "snare" | "hat") {
  if (!musicBus) return;

  if (kind === "hat") {
    // Tonal, low-level shimmer instead of white noise. The smooth oscillator
    // envelope avoids random sample edges that can crackle on phone speakers.
    scheduleOscillator(3400, start, 0.052, 0.0034, "triangle", musicBus, 5200);
    scheduleOscillator(5100, start + 0.003, 0.038, 0.0014, "sine", musicBus, 6200);
    return;
  }

  // A soft electronic rim/tom keeps the backbeat without a noise burst.
  scheduleOscillator(190, start, 0.13, 0.012, "triangle", musicBus, 1100);
  scheduleOscillator(330, start + 0.004, 0.095, 0.005, "sine", musicBus, 1500);
}

function scheduleMusicStep(step: number, start: number) {
  const bar = Math.floor(step / STEPS_PER_BAR);
  const stepInBar = step % STEPS_PER_BAR;
  const chord = CHORDS[bar];

  if (stepInBar === 0) schedulePad(chord, start, currentPhase === "menu");

  if (currentPhase === "menu") {
    if (stepInBar === 0 || stepInBar === 6 || stepInBar === 10 || stepInBar === 14) {
      const motifOffset = [0, 1, 2, 1][[0, 6, 10, 14].indexOf(stepInBar)];
      scheduleBell(MENU_MOTIF[(bar + motifOffset) % MENU_MOTIF.length], start, 0.013);
    }
    return;
  }

  if (currentPhase !== "play") return;

  if (stepInBar % 2 === 0) {
    const bassNote = chord[0] - 12 + (stepInBar === 14 ? 12 : 0);
    scheduleBass(bassNote, start, stepInBar === 0 || stepInBar === 8);

    const arpIndex = (stepInBar / 2 + bar) % chord.length;
    scheduleBell(chord[arpIndex] + 24, start, stepInBar === 0 ? 0.017 : 0.012);
    scheduleSoftPercussion(start, "hat");
  }

  if (stepInBar === 0 || stepInBar === 8) scheduleKick(start, stepInBar === 0);
  if (stepInBar === 4 || stepInBar === 12) scheduleSoftPercussion(start, "snare");
}

function schedulerTick() {
  if (!context || context.state !== "running") return;

  while (nextStepTime < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
    if (preferences.musicEnabled && currentPhase !== "over") {
      scheduleMusicStep(sequenceStep, nextStepTime);
    }
    sequenceStep = (sequenceStep + 1) % LOOP_STEPS;
    nextStepTime += SIXTEENTH_SECONDS;
  }
}

function resetTimeline() {
  if (!context) return;
  sequenceStep = 0;
  nextStepTime = context.currentTime + 0.055;
}

function startScheduler() {
  if (!context || schedulerId !== null) return;
  resetTimeline();
  schedulerTick();
  schedulerId = window.setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
}

function scheduleGameOverResolve() {
  if (!context || !musicBus || !preferences.musicEnabled) return;
  const start = context.currentTime + 0.018;
  [50, 57, 62, 65, 69].forEach((note, index) => {
    scheduleOscillator(
      midiToFrequency(note),
      start + index * 0.018,
      0.72,
      0.014,
      "triangle",
      musicBus!,
      1100,
      index % 2 === 0 ? -5 : 5
    );
  });
  scheduleBell(74, start + 0.08, 0.014);
}

export function getAudioPreferences(): GameAudioPreferences {
  loadPreferences();
  return { ...preferences };
}

export async function unlockGameAudio() {
  loadPreferences();
  const ctx = ensureAudioGraph();
  if (!ctx) return false;

  unlocked = true;
  try {
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    return false;
  }

  startScheduler();
  applyPhaseGain(0.35);
  return ctx.state === "running";
}

export function setAudioPhase(phase: GameAudioPhase) {
  const changed = currentPhase !== phase;
  currentPhase = phase;
  if (!context || !unlocked) return;

  if (phase === "over") {
    scheduleGameOverResolve();
    applyPhaseGain(0.7);
    return;
  }

  if (changed) resetTimeline();
  applyPhaseGain(phase === "play" ? 0.3 : 0.45);
}

export function setMusicEnabled(enabled: boolean) {
  loadPreferences();
  preferences.musicEnabled = enabled;
  persistPreference(MUSIC_STORAGE_KEY, enabled);

  if (!context || !unlocked) return;
  if (enabled && currentPhase !== "over") resetTimeline();
  applyPhaseGain(enabled ? 0.35 : 0.16);
}

export function setSfxEnabled(enabled: boolean) {
  loadPreferences();
  preferences.sfxEnabled = enabled;
  persistPreference(SFX_STORAGE_KEY, enabled);
  if (sfxBus) rampGain(sfxBus.gain, enabled ? 1.05 : 0.0001, 0.08);
}

export function playGameSfx(type: GameSoundEffect) {
  loadPreferences();
  if (!preferences.sfxEnabled) return;

  const ctx = ensureAudioGraph();
  if (!ctx || !sfxBus) return;
  unlocked = true;
  if (ctx.state === "suspended") void ctx.resume();
  startScheduler();
  duckMusicForEffect(type);

  const now = ctx.currentTime + 0.008;
  if (type === "hit") {
    scheduleOscillator(720, now, 0.072, 0.055, "sine", sfxBus, 2400);
    scheduleOscillator(480, now + 0.008, 0.065, 0.028, "triangle", sfxBus, 1800);
    return;
  }

  if (type === "destroy") {
    scheduleOscillator(255, now, 0.17, 0.095, "triangle", sfxBus, 1500);
    scheduleOscillator(410, now + 0.018, 0.14, 0.055, "sine", sfxBus, 2100);
    scheduleOscillator(660, now + 0.045, 0.1, 0.025, "sine", sfxBus, 2700);
    return;
  }

  if (type === "powerup") {
    scheduleOscillator(600, now, 0.18, 0.105, "sine", sfxBus, 3200);
    scheduleOscillator(900, now + 0.055, 0.2, 0.075, "sine", sfxBus, 3600);
    scheduleOscillator(1200, now + 0.11, 0.2, 0.055, "sine", sfxBus, 4200);
    return;
  }

  if (type === "gameover") {
    scheduleOscillator(330, now, 0.2, 0.075, "triangle", sfxBus, 1500);
    scheduleOscillator(247, now + 0.09, 0.24, 0.068, "triangle", sfxBus, 1200);
    scheduleOscillator(185, now + 0.2, 0.28, 0.052, "sine", sfxBus, 900);
    return;
  }

  scheduleOscillator(440, now, 0.2, 0.095, "square", sfxBus, 2100);
  scheduleOscillator(660, now + 0.07, 0.2, 0.075, "square", sfxBus, 2600);
  scheduleOscillator(880, now + 0.14, 0.22, 0.055, "square", sfxBus, 3200);
}

export function disposeGameAudio() {
  if (schedulerId !== null) {
    window.clearInterval(schedulerId);
    schedulerId = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }

  activeSources.forEach((source) => {
    try {
      source.stop();
    } catch {
      // The source may have already completed.
    }
  });
  activeSources.clear();

  if (context && context.state !== "closed") void context.close();
  context = null;
  compressor = null;
  musicBus = null;
  musicDuckBus = null;
  sfxBus = null;
  unlocked = false;
  nextStepTime = 0;
  sequenceStep = 0;
  currentPhase = "menu";
}
