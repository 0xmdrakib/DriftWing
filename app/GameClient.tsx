"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadEngine, type GameEngineInstance } from "@/lib/wasmLoader";
import { hasScoreboard, readBestScore, submitScore, waitForReceipt } from "@/lib/chain";
import {
  clearActiveEthereumProvider,
  getEthereumProvider,
  listInjectedWallets,
  setActiveEthereumProvider,
  setPreferredInjectedWalletId,
  type Eip1193Provider,
  type InjectedWallet,
} from "@/lib/ethProvider";
import {
  connectWalletConnect,
  disconnectWalletConnect,
  isWalletConnectConfigured,
} from "@/lib/walletConnect";
import {
  disposeGameAudio,
  getAudioPreferences,
  playGameSfx,
  setAudioPhase,
  setMusicEnabled as setGameMusicEnabled,
  setSfxEnabled as setGameSfxEnabled,
  unlockGameAudio,
} from "@/lib/gameAudio";

type Phase = "menu" | "play" | "over";
type Difficulty = "easy" | "medium" | "hard";

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Canvas round-rect helper (webview-safe)
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Difficulty config — game-logic values now live in Rust; only UI labels remain here.
const DIFF: Record<Difficulty, { label: string }> = {
  easy:   { label: "Easy" },
  medium: { label: "Medium" },
  hard:   { label: "Hard" },
};

export default function GameClient() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [phase, setPhase] = useState<Phase>("menu");
  const phaseRef = useRef<Phase>("menu");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const difficultyRef = useRef<Difficulty>("easy");
  useEffect(() => {
    difficultyRef.current = difficulty;
  }, [difficulty]);

  const [theme, setTheme] = useState<"glass" | "neon" | "scifi">("glass");
  const themeRef = useRef(theme);
  useEffect(() => { themeRef.current = theme; }, [theme]);

  const [scoreUi, setScoreUi] = useState(0);
  const [bestUi, setBestUi] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("");

  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [saving, setSaving] = useState(false);

  // Web-only: when multiple injected wallets are present (MetaMask + Rabby, etc.),
  // show a picker so the user can choose which injected provider to use.
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [injectedWalletOptions, setInjectedWalletOptions] = useState<InjectedWallet[]>([]);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
  // Tracks whether the current run’s score has been saved at least once (UI only).
  const [savedThisRun, setSavedThisRun] = useState(false);
  const saveLockRef = useRef(false);

  const canChain = useMemo(() => hasScoreboard(), []);
  const canSave = useMemo(() => canChain && Boolean(account), [canChain, account]);

  // Difficulty picker (single button + dropdown for a clean top bar).
  const [diffOpen, setDiffOpen] = useState(false);
  const diffWrapRef = useRef<HTMLDivElement | null>(null);
  const [audioOpen, setAudioOpen] = useState(false);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [sfxEnabled, setSfxEnabled] = useState(true);
  const audioWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (diffWrapRef.current && !diffWrapRef.current.contains(t)) {
        setDiffOpen(false);
      }
      if (audioWrapRef.current && !audioWrapRef.current.contains(t)) {
        setAudioOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    const saved = getAudioPreferences();
    setMusicEnabled(saved.musicEnabled);
    setSfxEnabled(saved.sfxEnabled);
    setAudioPhase(phaseRef.current);

    let didUnlock = false;
    const unlock = () => {
      if (didUnlock) return;
      didUnlock = true;
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      void unlockGameAudio();
    };

    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      disposeGameAudio();
    };
  }, []);

  const engineRef = useRef<GameEngineInstance | null>(null);
  // Lightweight TS-side ref for canvas dimensions, pointer tracking, and score (synced from WASM).
  const g = useRef({
    w: 0,
    h: 0,
    dpr: 1,
    tx: 0,
    dragging: false,
    score: 0,
    hitEvents: 0,
    destroyEvents: 0,
  });

  function setPhaseSafe(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
    setAudioPhase(p);
  }

  function toggleMusic() {
    const next = !musicEnabled;
    setMusicEnabled(next);
    setGameMusicEnabled(next);
    void unlockGameAudio();
  }

  function toggleSfx() {
    const next = !sfxEnabled;
    setSfxEnabled(next);
    setGameSfxEnabled(next);
    void unlockGameAudio();
  }

  async function doConnect(provider?: Eip1193Provider) {
    const eth = provider ?? (await getEthereumProvider());
    if (!eth) throw new Error("No wallet provider found");
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    const a = accounts?.[0] as `0x${string}` | undefined;
    if (!a) throw new Error("No account");
    setAccount(a);
    setStatus("Wallet connected");

    if (canChain) {
      try {
        const b = await readBestScore(a);
        if (typeof b === "number") setBestUi(b);
      } catch {
        // A temporary score-read failure should not undo a wallet connection.
        setStatus("Wallet connected • Best score unavailable");
      }
    }

    return { provider: eth, account: a };
  }

  function disconnect() {
    setAccount(null);
    setBestUi(null);
    setStatus("");
    setWalletPickerOpen(false);
    setInjectedWalletOptions([]);
    setConnectingWalletId(null);
    clearActiveEthereumProvider();
    setPreferredInjectedWalletId(null);
    void disconnectWalletConnect();
  }

  async function showWalletPicker(message?: string) {
    const wallets = await listInjectedWallets();
    setInjectedWalletOptions(wallets);
    setWalletPickerOpen(true);
    if (message) setStatus(message);
  }

  function connectionWasCancelled(error: any) {
    const message = String(error?.message || "");
    return error?.code === 4001 || /rejected|denied|cancelled|canceled|modal closed/i.test(message);
  }

  async function returnToWalletList(error: any) {
    setAccount(null);
    clearActiveEthereumProvider();
    setPreferredInjectedWalletId(null);
    setStatus(
      connectionWasCancelled(error)
        ? "Connection cancelled. Choose a wallet when you are ready."
        : error?.message || "Wallet connect failed"
    );
    await showWalletPicker();
  }

  async function connect() {
    try {
      // Always let the user choose. Never auto-request the previously used
      // extension after a cancellation or app-level disconnect.
      clearActiveEthereumProvider();
      setPreferredInjectedWalletId(null);
      await showWalletPicker();
    } catch (e: any) {
      setStatus(e?.message || "Wallet connect failed");
    }
  }

  async function chooseInjectedWallet(w: InjectedWallet) {
    setConnectingWalletId(w.id);
    setWalletPickerOpen(false);
    try {
      const connected = await doConnect(w.provider);
      setActiveEthereumProvider(connected.provider);
      // Persist only after approval. A rejected request must never become the
      // automatic provider for the next attempt.
      setPreferredInjectedWalletId(w.id);
      setInjectedWalletOptions([]);
    } catch (e: any) {
      await returnToWalletList(e);
    } finally {
      setConnectingWalletId(null);
    }
  }

  async function chooseWalletConnect() {
    setConnectingWalletId("walletconnect");
    setWalletPickerOpen(false);
    setPreferredInjectedWalletId(null);
    try {
      const provider = await connectWalletConnect();
      const connected = await doConnect(provider);
      setActiveEthereumProvider(connected.provider);
      setInjectedWalletOptions([]);
    } catch (e: any) {
      await returnToWalletList(e);
    } finally {
      setConnectingWalletId(null);
    }
  }

  function closeWalletPicker() {
    setWalletPickerOpen(false);
    setInjectedWalletOptions([]);
    setConnectingWalletId(null);
    clearActiveEthereumProvider();
    setPreferredInjectedWalletId(null);
  }

  async function saveScoreOnchain(score: number, restartAfter: boolean) {
    if (!canChain) return;
    if (!account) {
      setStatus("Connect wallet to save your score onchain.");
      return;
    }

    // Guard: prevent double-taps while a save is in flight.
    if (saveLockRef.current) return;
    saveLockRef.current = true;

    setSaving(true);
    setStatus("Saving score onchain…");
    try {
      const { hash } = await submitScore(score);
      setStatus(`Tx sent ✓ (${hash.slice(0, 10)}…) • Confirming…`);
      await waitForReceipt(hash);

      setSavedThisRun(true);
      setStatus(`Score saved onchain ✓ (${hash.slice(0, 10)}…)`);

      // Refresh best score from the contract.
      const b = await readBestScore(account);
      if (typeof b === "number") setBestUi(b);

      if (restartAfter) {
        // auto restart after a short beat
        setTimeout(() => {
          restart("play");
        }, 900);
      }
    } catch (e: any) {
      // allow retry
      saveLockRef.current = false;
      // keep savedThisRun as-is; user may save multiple times

      const msg = String(e?.message || "");
      // MetaMask reject is often 4001; message varies by wallet/webview.
      if (e?.code === 4001 || /rejected|denied|user rejected/i.test(msg)) {
        setStatus("User rejected the transaction.");
      } else {
        setStatus(msg || "Submit failed");
      }
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  }

  function resetCore(targetPhase: Phase) {
    if (engineRef.current) {
      engineRef.current.reset(targetPhase, difficultyRef.current, performance.now());
    }
    saveLockRef.current = false;
    setSavedThisRun(false);
    setStatus("");
    setScoreUi(0);
    g.current.score = 0;
    g.current.hitEvents = 0;
    g.current.destroyEvents = 0;
  }

  function restart(into: Phase) {
    resetCore(into);
    setPhaseSafe(into);
  }

  function start() {
    playGameSfx("start");
    restart("play");
  }

  function endGame() {
    if (phaseRef.current !== "play") return;
    playGameSfx("gameover");
    setPhaseSafe("over");

    // Manual onchain save: user chooses when to save (avoids forced tx prompts).
    if (canChain) {
      setStatus(account ? 'Game over. Tap "Save onchain" to record your score.' : "Game over. Connect your wallet to save your score onchain.");
    }
  }


  // Resize + input + game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gg = g.current;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      gg.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const nextW = Math.max(1, Math.floor(rect.width * gg.dpr));
      const nextH = Math.max(1, Math.floor(rect.height * gg.dpr));
      if (canvas.width !== nextW || canvas.height !== nextH) {
        gg.w = nextW;
        gg.h = nextH;
        canvas.width = gg.w;
        canvas.height = gg.h;
        gg.tx = Math.floor(gg.w * 0.5);
        if (engineRef.current) {
          try {
            engineRef.current.resize(gg.w, gg.h, gg.dpr);
          } catch (e) {
            console.warn("WASM Resize Error:", e);
          }
        }
      }
    };

    resize();

    // Load WASM engine asynchronously, then do initial resize + start loop.
    let cancelled = false;
    loadEngine().then(({ GameEngine }) => {
      if (cancelled) return;
      if (!engineRef.current) {
        try {
          engineRef.current = new GameEngine();
          engineRef.current.reset(phaseRef.current, difficultyRef.current, performance.now());
          engineRef.current.resize(gg.w, gg.h, gg.dpr);
        } catch (e) {
          console.error("WASM Init Error:", e);
          engineRef.current = null;
        }
      }
    });

    // ResizeObserver is great when available, but some in-app WebViews are missing it
    // or don't reliably fire it on orientation changes. So we add window fallbacks.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(canvas);
    }

    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    const pointerToX = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * gg.dpr;
      return clamp(x, 24 * gg.dpr, gg.w - 24 * gg.dpr);
    };

    const onDown = (e: PointerEvent) => {
      gg.dragging = true;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      gg.tx = pointerToX(e);
    };
    const onMove = (e: PointerEvent) => {
      if (!gg.dragging) return;
      gg.tx = pointerToX(e);
    };
    const onUp = () => {
      gg.dragging = false;
    };

    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);

    // Rendering helpers
    const drawStars = (ctx: CanvasRenderingContext2D, t: number, starColor: string) => {
      ctx.save();
      ctx.fillStyle = starColor;
      for (let i = 0; i < 30; i++) {
        const x = (((i * 97) % 1013) / 1013) * gg.w;
        const y = (((i * 173 + t * 0.03) % 997) / 997) * gg.h;
        // Draw tiny random marker dots / pluses
        ctx.fillRect(x, y, 4 * gg.dpr, 4 * gg.dpr);
      }
      ctx.restore();
    };

    const drawPlane = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      scale: number,
      fill: string,
      outline: string,
      flame: boolean,
      tilt: number,
      facingDown: boolean
    ) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((facingDown ? Math.PI : 0) + tilt);
      ctx.scale(scale, scale);

      // Jet silhouette (Doodle Style)
      ctx.fillStyle = fill;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";

      ctx.beginPath();
      ctx.moveTo(0, -30);
      ctx.lineTo(8, -18);
      ctx.lineTo(10, -8);
      ctx.lineTo(28, 0);
      ctx.lineTo(10, 6);
      ctx.lineTo(8, 16);
      ctx.lineTo(8, 22);
      ctx.lineTo(14, 26);
      ctx.lineTo(0, 22);
      ctx.lineTo(-14, 26);
      ctx.lineTo(-8, 22);
      ctx.lineTo(-8, 16);
      ctx.lineTo(-10, 6);
      ctx.lineTo(-28, 0);
      ctx.lineTo(-10, -8);
      ctx.lineTo(-8, -18);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Fun little cockpit
      ctx.fillStyle = "#FFF";
      ctx.beginPath();
      ctx.ellipse(0, -13, 5, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Thruster doodle
      if (flame) {
        ctx.fillStyle = "#FFE600";
        ctx.beginPath();
        ctx.ellipse(0, 25, 6, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    };

    const drawBullet = (ctx: CanvasRenderingContext2D, b: { x: number; y: number }) => {
      ctx.save();
      ctx.translate(b.x, b.y);

      // Simple fat bullet doodle
      ctx.fillStyle = "#FFF";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 3;

      ctx.beginPath();
      ctx.ellipse(0, 0, 4, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      
      ctx.restore();
    };

    const powerupBurstPath = (
      ctx: CanvasRenderingContext2D,
      outer: number,
      inner: number
    ) => {
      ctx.beginPath();
      for (let i = 0; i < 20; i += 1) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 10;
        const radius = i % 2 === 0 ? outer : inner;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    const drawPickupJet = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      scale: number
    ) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.fillStyle = "#000";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(2.5, -3);
      ctx.lineTo(7, 1);
      ctx.lineTo(2.5, 2.5);
      ctx.lineTo(2, 7);
      ctx.lineTo(0, 5.5);
      ctx.lineTo(-2, 7);
      ctx.lineTo(-2.5, 2.5);
      ctx.lineTo(-7, 1);
      ctx.lineTo(-2.5, -3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    const drawPowerup = (ctx: CanvasRenderingContext2D, p: any, time: number) => {
      const isOverdrive = p.t === "Overdrive";
      const dpr = gg.dpr;
      const pulse = 1 + Math.sin(time * 0.009 + Number(p.id || 0)) * 0.07;
      const outer = 21 * dpr;
      const inner = 17 * dpr;
      const color = isOverdrive ? "#3BEFFF" : "#9DFF3B";
      const label = isOverdrive ? "2X FIRE" : "WINGMEN";

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(time * 0.004 + Number(p.id || 0)) * 0.055);
      ctx.scale(pulse, pulse);

      // Animated dashed halo makes pickups read differently from enemies.
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineDashOffset = -(time * 0.02) % (8 * dpr);
      ctx.beginPath();
      ctx.arc(0, 0, 27 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Doodle shadow + bright starburst badge.
      ctx.save();
      ctx.translate(3 * dpr, 3 * dpr);
      ctx.fillStyle = "#000";
      powerupBurstPath(ctx, outer, inner);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = color;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 3 * dpr;
      ctx.lineJoin = "round";
      powerupBurstPath(ctx, outer, inner);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#FFF";
      if (isOverdrive) {
        ctx.beginPath();
        ctx.arc(0, 0, 13 * dpr, 0, Math.PI * 2);
      } else {
        roundRectPath(ctx, -17 * dpr, -11.5 * dpr, 34 * dpr, 23 * dpr, 9 * dpr);
      }
      ctx.fill();
      ctx.stroke();

      if (isOverdrive) {
        ctx.fillStyle = "#000";
        ctx.font = `900 ${12 * dpr}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("×2", 0, 0.5 * dpr);

        // Twin upward streaks reinforce the double-fire meaning.
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 2 * dpr;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-7 * dpr, -10 * dpr);
        ctx.lineTo(-7 * dpr, -17 * dpr);
        ctx.moveTo(7 * dpr, -10 * dpr);
        ctx.lineTo(7 * dpr, -17 * dpr);
        ctx.stroke();
      } else {
        drawPickupJet(ctx, 0, -1.5 * dpr, 0.86 * dpr);
        drawPickupJet(ctx, -10.5 * dpr, 3 * dpr, 0.56 * dpr);
        drawPickupJet(ctx, 10.5 * dpr, 3 * dpr, 0.56 * dpr);
      }

      const labelY = 25 * dpr;
      ctx.font = `900 ${7 * dpr}px sans-serif`;
      const labelWidth = ctx.measureText(label).width + 10 * dpr;
      roundRectPath(ctx, -labelWidth / 2, labelY, labelWidth, 13 * dpr, 4 * dpr);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.fillStyle = "#FFF";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 0, labelY + 6.5 * dpr);

      ctx.restore();
    };

    
    // UI throttle
    let lastUi = performance.now();

    const getThemeColors = () => {
      return {
        stars: "#000",
        bossFill: "#FF3B7C", bossStroke: "#000", bossHp: "#FF3B7C",
        scoutFill: "#3BEFFF", scoutStroke: "#000",
        zigzagFill: "#FF9B3B", zigzagStroke: "#000",
        tankFill: "#9DFF3B", tankStroke: "#000",
        playerFill: "#FFF", playerStroke: "#000",
      };
    };

    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (!engineRef.current) return;
      let state: any;
      try {
        if (phaseRef.current === "play") {
          engineRef.current.set_target_x(gg.tx);
        }
        engineRef.current.update(t);
        state = engineRef.current.get_state();
      } catch (e) {
        console.error("WASM Error:", e);
        return;
      }
      
      // Rust exposes monotonic event counters so a hit and a destruction can
      // have distinct feedback without guessing from the score value.
      const scoreDiff = state.score - (gg.score || 0);
      const hitEvents = Number(state.hit_events || 0);
      const destroyEvents = Number(state.destroy_events || 0);
      const didHit = hitEvents !== gg.hitEvents;
      const didDestroy = destroyEvents !== gg.destroyEvents;

      if (didDestroy) {
        playGameSfx("destroy");
        if (scoreDiff >= 500) setTimeout(() => playGameSfx("powerup"), 90);
      } else if (didHit) {
        playGameSfx("hit");
      } else if (scoreDiff === 50) {
        playGameSfx("powerup");
      }
      
      // sync internal score
      gg.score = state.score;
      gg.hitEvents = hitEvents;
      gg.destroyEvents = destroyEvents;

      // Rust serde serializes unit enum variants as plain strings
      if (state.phase === "Over" && phaseRef.current === "play") {
         endGame();
      }

      ctx.clearRect(0, 0, gg.w, gg.h);
      canvas.style.backgroundColor = `hsl(${54 - (Math.min(1, state.score / 5000) * 80)}, 87%, 73%)`;
ctx.save();
      const shakeAmt = state.shake || 0;
      if (shakeAmt > 0) {
        ctx.translate((Math.random() - 0.5) * shakeAmt, (Math.random() - 0.5) * shakeAmt);
      }
      
      const tc = getThemeColors();
      drawStars(ctx, t, tc.stars);
      
      // Powerups
      if (state.powerups) {
        for (const p of state.powerups) {
          drawPowerup(ctx, p, t);
        }
      }

      // Particles (Comic explosions)
      if (state.particles) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#000";
        for (const p of state.particles) {
            const ratio = p.life / p.max_life;
            const sz = ratio * 12 * gg.dpr;
            ctx.fillStyle = Math.random() > 0.5 ? "#FF9B3B" : "#FF3B7C";
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.life * 15);
            ctx.beginPath();
            ctx.moveTo(sz, 0);
            ctx.lineTo(sz/3, sz/3);
            ctx.lineTo(0, sz);
            ctx.lineTo(-sz/3, sz/3);
            ctx.lineTo(-sz, 0);
            ctx.lineTo(-sz/3, -sz/3);
            ctx.lineTo(0, -sz);
            ctx.lineTo(sz/3, -sz/3);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
      }

      // enemies
      for (const e of state.enemies) {
        const isBoss = e.t === "Boss";
        const isScout = e.t === "Scout";
        const isZigzag = e.t === "Zigzag";
        const isTank = e.t === "Tank";

        const tilt = isZigzag ? Math.sin(t * 0.01) * 0.18 : 0;

        if (isBoss) {
          drawPlane(ctx, e.x, e.y, 1.35 * gg.dpr, tc.bossFill, tc.bossStroke, false, tilt, true);
          const w = 150 * gg.dpr;
          const h = 10 * gg.dpr;
          const x = e.x - w / 2;
          const y = e.y - 60 * gg.dpr;
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "rgba(255,255,255,.10)";
          roundRectPath(ctx, x, y, w, h, 999);
          ctx.fill();
          const frac = Math.max(0, Math.min(1, e.hp / e.max_hp));
          ctx.fillStyle = tc.bossHp;
          roundRectPath(ctx, x, y, w * frac, h, 999);
          ctx.fill();
          ctx.restore();
        } else {
          let fill = tc.scoutFill;
          let stroke = tc.scoutStroke;
          if (isScout) {
            fill = tc.scoutFill; stroke = tc.scoutStroke;
          } else if (isZigzag) {
            fill = tc.zigzagFill; stroke = tc.zigzagStroke;
          } else if (isTank) {
            fill = tc.tankFill; stroke = tc.tankStroke;
          }
          drawPlane(ctx, e.x, e.y, 1.05 * gg.dpr, fill, stroke, false, tilt, true);
        }
      }

      // bullets
      for (const b of state.bullets) {
         drawBullet(ctx, b);
      }

      // Player Trail
      (gg as any).trail = (gg as any).trail || [];
      (gg as any).trail.push({x: state.px, y: state.py + 15 * gg.dpr});
      if ((gg as any).trail.length > 15) (gg as any).trail.shift();
      
      ctx.save();
      ctx.lineWidth = 2 * gg.dpr;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      for (let i = 0; i < (gg as any).trail.length; i++) {
          const pt = (gg as any).trail[i];
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.restore();

      // player plane
      const playerTilt = (gg.tx - state.px) / (gg.w * 0.45);
      const clampTilt = Math.max(-0.22, Math.min(0.22, playerTilt));
      drawPlane(
        ctx,
        state.px,
        state.py,
        1.15 * gg.dpr,
        tc.playerFill,
        tc.playerStroke,
        state.flame,
        clampTilt,
        false
      );
      
      // Ally Drones
      if (state.drones) {
         drawPlane(ctx, state.px - 36 * gg.dpr, state.py + 10 * gg.dpr, 0.6 * gg.dpr, "#9DFF3B", "#000", state.flame, clampTilt, false);
         drawPlane(ctx, state.px + 36 * gg.dpr, state.py + 10 * gg.dpr, 0.6 * gg.dpr, "#9DFF3B", "#000", state.flame, clampTilt, false);
      }
      

      ctx.restore(); // Ensure we restore translation for shake
      
      if (t - lastUi >= 90) {
        lastUi = t;
        setScoreUi(Math.floor(state.score));
      }
    };

    raf = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [canChain, account]);

  // Apply difficulty changes immediately by restarting if currently playing/menu.
  useEffect(() => {
    // When difficulty changes, restart into menu (user can press Start quickly)
    restart(phaseRef.current === "over" ? "over" : "menu");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [difficulty]);

  // Try silent connect to fetch best score (if wallet already connected)
  useEffect(() => {
    (async () => {
      try {
        const eth = await getEthereumProvider();
        if (!eth) return;
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        const a = accounts?.[0] as `0x${string}` | undefined;
        if (!a) return;
        setAccount(a);
        if (canChain) {
          const b = await readBestScore(a);
          if (typeof b === "number") setBestUi(b);
        }
      } catch {
        // ignore
      }
    })();
  }, [canChain]);

  const topBestText = bestUi === null ? "—" : String(bestUi);
  const acctShort = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "";

  return (
    <div className="dw" data-theme={theme}>
      <div className="dwTop">
        <div className="dwLeft">
          <div className="dwStat">
            <span>Score</span>
            <b>{scoreUi}</b>
          </div>

          <div
            className="dwAudioMenu"
            ref={audioWrapRef}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className={
                "dwAudioTrigger" + (!musicEnabled && !sfxEnabled ? " isMuted" : "")
              }
              type="button"
              aria-label="Audio settings"
              aria-haspopup="true"
              aria-expanded={audioOpen}
              title="Audio settings"
              onClick={() => {
                setDiffOpen(false);
                setAudioOpen((open) => !open);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 10v4h4l5 4V6L8 10H4Z" />
                {musicEnabled || sfxEnabled ? (
                  <>
                    <path className="dwAudioWave" d="M16 9c1.1 1.7 1.1 4.3 0 6" />
                    <path className="dwAudioWave" d="M19 6.5c2.6 3 2.6 8 0 11" />
                  </>
                ) : (
                  <path className="dwAudioWave" d="m16 9 5 6m0-6-5 6" />
                )}
              </svg>
            </button>

            {audioOpen && (
              <div className="dwAudioPopover" role="group" aria-label="Audio settings">
                <div className="dwAudioTitle">Sound</div>
                <button
                  className={"dwAudioToggle" + (musicEnabled ? " isOn" : "")}
                  type="button"
                  aria-pressed={musicEnabled}
                  onClick={toggleMusic}
                >
                  <span>Music</span>
                  <b>{musicEnabled ? "On" : "Off"}</b>
                </button>
                <button
                  className={"dwAudioToggle" + (sfxEnabled ? " isOn" : "")}
                  type="button"
                  aria-pressed={sfxEnabled}
                  onClick={toggleSfx}
                >
                  <span>SFX</span>
                  <b>{sfxEnabled ? "On" : "Off"}</b>
                </button>
              </div>
            )}
          </div>
        </div>
        
        <div className="dwRight">
          {/* Difficulty (dropdown) */}
          <div className="dwDiffMenu" ref={diffWrapRef}>
            <button
              className="dwBtn dwDiffSelect"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAudioOpen(false);
                setDiffOpen((v) => !v);
              }}
              aria-haspopup="menu"
              aria-expanded={diffOpen}
              aria-label="Select difficulty"
              title="Difficulty"
            >
              {DIFF[difficulty].label} <span className="dwCaret">▾</span>
            </button>

            {diffOpen && (
              <div className="dwDiffList" role="menu" aria-label="Difficulty">
                {(["easy", "medium", "hard"] as Difficulty[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={"dwDiffItem " + (difficulty === d ? "isOn" : "")}
                    role="menuitemradio"
                    aria-checked={difficulty === d}
                    onClick={() => {
                      setDifficulty(d);
                      setDiffOpen(false);
                    }}
                  >
                    <div className="dwDiffItemTop">
                      <div className="dwDiffItemTitle">{DIFF[d].label}</div>
                      {difficulty === d && <div className="dwCheck">✓</div>}
                    </div>
                    <div className="dwDiffItemSub">
                      {d === "easy"
                        ? "Chill & forgiving"
                        : d === "medium"
                        ? "Balanced pace"
                        : "Fast & intense"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
</div>

        <div className="dwRight">
{account ? (
            <div
              className="dwAccountPill"
              onClick={(e) => e.stopPropagation()}
              title="Connected wallet"
            >
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#4ade80", border: '2px solid #000' }} />
              <span style={{ fontSize: "1.1rem" }}>{account.slice(0, 6)}...{account.slice(-4)}</span>
              <button
                className="dwDisconnectButton"
                type="button"
                title="Disconnect wallet"
                aria-label="Disconnect wallet"
                onClick={(e) => {
                  e.stopPropagation();
                  disconnect();
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
              </button>
            </div>
          ) : (
            <button className="dwBtn dwPrimary" onClick={(e) => { e.stopPropagation(); connect(); }} type="button">
              Connect
            </button>
          )}
        </div>
      </div>

      <div className="dwStage">
        <canvas ref={canvasRef} className="dwCanvas" style={{ touchAction: 'none' }} />

        {phase === "menu" && (
          <div className="dwOverlay dwTapToStart" style={{ background: "transparent", cursor: "pointer" }} onClick={start}>
             <div style={{ textAlign: "center", pointerEvents: "none" }}>
                <div style={{ fontSize: "2.5rem", fontWeight: 900, color: "#FFF", textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000", letterSpacing: "2px" }}>TAP TO START</div>
             </div>
          </div>
        )}

        {phase === "over" && (
          <div className="dwOverlay">
            <div className="dwModal">
              <div className="dwModalTitle">Game Over</div>
              <div className="dwModalScore">
                <div>
                  <span>Score</span>
                  <b>{scoreUi}</b>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span>Best</span>
                  <b>{topBestText}</b>
                </div>
              </div>

              <div className="dwRow">
                <button className="dwBtn dwPlayAgainButton" onClick={start} type="button">
                  Play again
                </button>
              </div>

              {phase === "over" && canChain && (
                <div className="dwRow">
                  <button
                    className="dwBtn dwSaveButton"
                    onClick={saving ? () => {} : account ? () => saveScoreOnchain(scoreUi, false) : connect}
                    type="button"
                    disabled={saving}
                  >
                    {account ? (saving ? "Saving…" : "Save onchain") : "Connect to save"}
                  </button>
                  {savedThisRun && (
                    <div className="dwSavedPill" aria-label="saved onchain">
                      Score saved onchain ✓
                    </div>
                  )}
                </div>
              )}
              <div className="dwNote">
                {canChain ? (
                  <>
                    You can save your score <b>onchain</b> after game over. {account ? "" : "Connect to save."}
                  </>
                ) : (
                  <>Onchain saving is disabled (set NEXT_PUBLIC_SCOREBOARD_ADDRESS).</>
                )}
              </div>
            </div>
          </div>
        )}

        {walletPickerOpen && (
          <div className="dwOverlay dwOverlayTop" onClick={closeWalletPicker}>
            <div className="dwModal dwWalletModal" onClick={(e) => e.stopPropagation()}>
              <div className="dwModalTitle">Choose wallet</div>
              <div className="dwNote">
                Select an installed wallet, or use WalletConnect to connect from another device.
              </div>

              <div className="dwWalletList" aria-busy={Boolean(connectingWalletId)}>
                {injectedWalletOptions.map((w) => (
                  <button
                    key={w.id}
                    className="dwBtn dwWalletOption"
                    type="button"
                    onClick={() => chooseInjectedWallet(w)}
                  >
                    {w.icon ? (
                      // EIP-6963 icons are usually data URIs.
                      <img className="dwWalletIcon" src={w.icon} alt="" width={22} height={22} />
                    ) : (
                      <span className="dwWalletFallbackIcon" aria-hidden="true">◦</span>
                    )}
                    <span>{w.name}</span>
                  </button>
                ))}

                {isWalletConnectConfigured() && (
                  <button
                    className="dwBtn dwWalletOption dwWalletConnectOption"
                    type="button"
                    onClick={chooseWalletConnect}
                  >
                    <span className="dwWalletConnectIcon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" role="presentation">
                        <path d="M5.2 9.4a9.65 9.65 0 0 1 13.6 0l.45.45-1.7 1.7-.45-.45a7.24 7.24 0 0 0-10.2 0l-.45.45-1.7-1.7.45-.45Zm15.15 2.55 1.5 1.5-4.7 4.7a.8.8 0 0 1-1.15 0l-3.3-3.3a1 1 0 0 0-1.4 0L8 18.15a.8.8 0 0 1-1.15 0l-4.7-4.7 1.5-1.5 3.75 3.75 2.4-2.4a3.1 3.1 0 0 1 4.4 0l2.4 2.4 3.75-3.75Z" />
                      </svg>
                    </span>
                    <span>WalletConnect</span>
                  </button>
                )}
              </div>

              <div className="dwRow">
                <button className="dwBtn dwWalletCancel" type="button" onClick={closeWalletPicker}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="dwBottom">
          <div className="dwStatus">
            {saving ? "Saving…" : status}
          </div>
        </div>
      </div>
    </div>
  );
}
