"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadEngine, type GameEngineInstance } from "@/lib/wasmLoader";
import { sdk } from "@farcaster/miniapp-sdk";
import { hasScoreboard, readBestScore, submitScore, waitForReceipt } from "@/lib/chain";
import {
  getEthereumProvider,
  getPreferredInjectedWalletId,
  listInjectedWallets,
  setPreferredInjectedWalletId,
  type InjectedWallet,
} from "@/lib/ethProvider";

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
// Leaderboard UI (weekly top 100)
  const [lbOpen, setLbOpen] = useState(false);
  const [lbLoading, setLbLoading] = useState(false);
  const [lbErr, setLbErr] = useState("");
  const [lbTop, setLbTop] = useState<Array<{ address: `0x${string}`; score: number }>>([]);
  const [lbWeekId, setLbWeekId] = useState<number | null>(null);
  const [lbEndMs, setLbEndMs] = useState<number | null>(null);
  const [lbNow, setLbNow] = useState<number>(Date.now());
  const [lbMyRank, setLbMyRank] = useState<number | null>(null);
  const [lbKvEnabled, setLbKvEnabled] = useState<boolean | null>(null);
  const [lbUpdating, setLbUpdating] = useState(false);
  const [lbCurrentWeekId, setLbCurrentWeekId] = useState<number | null>(null);
  const lbRolloverForEndRef = useRef<number | null>(null);

  // Avoid extra network refreshes caused by effect re-runs when lbEndMs changes.
  // We keep the week end timestamp in a ref for the countdown/tick logic.
  const lbEndMsRef = useRef<number | null>(null);
  // Guard against spamming the API if the tick notices a week rollover.
  const lbLoadingRef = useRef(false);

  function fmtLeft(msLeft: number) {
    const s = Math.max(0, Math.floor(msLeft / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m ${ss}s`;
    if (h > 0) return `${h}h ${m}m ${ss}s`;
    return `${m}m ${ss}s`;
  }

  async function loadLeaderboard(weekOverride?: number) {
    try {
      setLbErr("");
      const initial = lbTop.length === 0;
      if (initial) setLbLoading(true);
      else setLbUpdating(true);
      lbLoadingRef.current = true;
      const params = new URLSearchParams();
      if (account) params.set("account", account);
      if (typeof weekOverride === "number" && Number.isFinite(weekOverride)) params.set("week", String(weekOverride));
      const qs = params.toString();
      const res = await fetch(`/api/leaderboard${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      const raw = await res.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(raw ? raw.slice(0, 200) : `Empty response (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(data?.message || data?.error || `Failed to load leaderboard (HTTP ${res.status})`);
      }
      setLbWeekId(data.weekId);
      setLbCurrentWeekId(typeof data.currentWeekId === "number" ? data.currentWeekId : data.weekId);
      setLbEndMs(data.weekEndMs);
      lbEndMsRef.current = typeof data.weekEndMs === "number" ? data.weekEndMs : null;
      setLbTop(data.top || []);
      setLbMyRank(typeof data.myRank === "number" ? data.myRank : null);
      setLbKvEnabled(Boolean(data.kvEnabled));
    } catch (e: any) {
      setLbErr(e?.message || "Failed to load leaderboard");
    } finally {
      setLbLoading(false);
      setLbUpdating(false);
      lbLoadingRef.current = false;
    }
  }

  useEffect(() => {
    if (!lbOpen) return;

    // Network refresh cadence: keep it gentle.
    const LB_REFRESH_MS = 15_000;

    // Always start by loading the current week.
    loadLeaderboard();

    const refresh = setInterval(() => {
      // Only auto-refresh when viewing the current week.
      const viewingCurrent = lbCurrentWeekId == null || lbWeekId == null || lbCurrentWeekId === lbWeekId;
      if (viewingCurrent) loadLeaderboard();
    }, LB_REFRESH_MS);

    // UI-only ticker for the countdown clock (no network).
    const tick = setInterval(() => {
      setLbNow(Date.now());

      const viewingCurrent = lbCurrentWeekId == null || lbWeekId == null || lbCurrentWeekId === lbWeekId;
      if (!viewingCurrent) return;

      // When the week rolls over, refresh exactly once.
      const end = lbEndMsRef.current;
      if (end && Date.now() >= end && !lbLoadingRef.current && lbRolloverForEndRef.current !== end) {
        lbRolloverForEndRef.current = end;
        loadLeaderboard();
      }
    }, 1_000);

    return () => {
      clearInterval(refresh);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lbOpen, account, lbWeekId, lbCurrentWeekId]);



  // Tracks whether the current run’s score has been saved at least once (UI only).
  const [savedThisRun, setSavedThisRun] = useState(false);
  const saveLockRef = useRef(false);

  const canChain = useMemo(() => hasScoreboard(), []);
  const canSave = useMemo(() => canChain && Boolean(account), [canChain, account]);

  // Difficulty picker (single button + dropdown for a clean top bar).
  const [diffOpen, setDiffOpen] = useState(false);
  const diffWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointerDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (diffWrapRef.current && !diffWrapRef.current.contains(t)) {
        setDiffOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
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
  });

  function setPhaseSafe(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  async function doConnect() {
    const eth = await getEthereumProvider();
    if (!eth) throw new Error("No wallet provider found");
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    const a = accounts?.[0] as `0x${string}` | undefined;
    if (!a) throw new Error("No account");
    setAccount(a);
    setStatus("Wallet connected");

    if (canChain) {
      const b = await readBestScore(a);
      if (typeof b === "number") setBestUi(b);
    }
  }

  function disconnect() {
    setAccount(null);
    setStatus("");
    try { setPreferredInjectedWalletId(null); } catch(e) {}
  }

  async function connect() {
    try {
      // If we're not in a Farcaster Mini App, prefer injected wallet UX on web.
      let inMiniApp = false;
      try {
        inMiniApp = await sdk.isInMiniApp();
      } catch {
        inMiniApp = false;
      }

      if (!inMiniApp) {
        const wallets = await listInjectedWallets();
        const hasChoice = Boolean(getPreferredInjectedWalletId());
        if (wallets.length > 1 && !hasChoice) {
          setInjectedWalletOptions(wallets);
          setWalletPickerOpen(true);
          return;
        }
      }

      await doConnect();
    } catch (e: any) {
      setStatus(e?.message || "Wallet connect failed");
    }
  }

  async function chooseInjectedWallet(w: InjectedWallet) {
    try {
      setPreferredInjectedWalletId(w.id);
      setWalletPickerOpen(false);
      setInjectedWalletOptions([]);
      await doConnect();
    } catch (e: any) {
      setStatus(e?.message || "Wallet connect failed");
    }
  }

  function closeWalletPicker() {
    setWalletPickerOpen(false);
    setInjectedWalletOptions([]);
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

      // Update weekly leaderboard (server verifies the tx event).
      try {
        const r = await fetch("/api/leaderboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash: hash }),
        });
        const d = await r.json();
        if (r.ok && d?.status === "ok") {
          const rank = typeof d?.myRank === "number" ? d.myRank : null;
          setStatus(
            rank
              ? `Score saved ✓ • Weekly rank #${rank}`
              : "Score saved ✓ • Leaderboard updated"
          );
          // If the leaderboard is open, refresh it.
          if (lbOpen) loadLeaderboard();
        }
      } catch {
        // ignore leaderboard update errors (score is still onchain)
      }

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

  async function shareScore() {
    try {
      await sdk.actions.composeCast({
        text: `I scored ${g.current.score} in DriftWing ✈️🔥`,
        embeds: [window.location.href],
      });
    } catch {
      // ignore
    }
  }

  function resetCore(targetPhase: Phase) {
    if (engineRef.current) {
      engineRef.current.reset(targetPhase, difficultyRef.current, performance.now());
    }
    saveLockRef.current = false;
    setSavedThisRun(false);
    setLbOpen(false);
    setStatus("");
    setScoreUi(0);
  }

  function restart(into: Phase) {
    resetCore(into);
    setPhaseSafe(into);
  }

  function start() {
    setLbOpen(false);
    restart("play");
  }

  function endGame() {
    if (phaseRef.current !== "play") return;
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
      gg.w = Math.max(1, Math.floor(rect.width * gg.dpr));
      gg.h = Math.max(1, Math.floor(rect.height * gg.dpr));
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
      
      // sync internal score
      gg.score = state.score;

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
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#000";
        for (const p of state.powerups) {
            ctx.save();
            ctx.translate(p.x, p.y);
            const sz = 14 * gg.dpr;
            
            ctx.fillStyle = p.t === "Overdrive" ? "#3BEFFF" : "#9DFF3B";
            
            ctx.beginPath();
            ctx.rect(-sz/2, -sz/2, sz, sz);
            ctx.fill();
            ctx.stroke();
            
            ctx.fillStyle = "#000";
            ctx.font = "900 " + (10 * gg.dpr) + "px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(p.t === "Overdrive" ? "O" : "M", 0, 2 * gg.dpr);
            ctx.restore();
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
          <div className="dwStat">
            <span>Best</span>
            <b>{topBestText}</b>
          </div>
          
        </div>
        
        <div className="dwRight">
          {/* Difficulty (dropdown) */}
          <div className="dwDiffMenu" ref={diffWrapRef}>
            <button
              className="dwBtn dwDiffSelect"
              type="button"
              onClick={(e) => { e.stopPropagation(); setDiffOpen((v) => !v); }}
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
            <button
              className="dwAccountPill"
              onClick={(e) => { e.stopPropagation(); disconnect(); }}
              type="button"
              title="Disconnect"
            >
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#4ade80", border: '2px solid #000' }} />
              <span style={{ fontSize: "1.1rem" }}>{account.slice(0, 6)}...{account.slice(-4)}</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
            </button>
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
                <button className="dwBtn dwPrimary" onClick={start} type="button">
                  Play again
                </button>
                <button className="dwBtn" onClick={shareScore} type="button">
                  Share
                </button>
              </div>

              <div className="dwRow">
                <button className="dwBtn" onClick={() => setLbOpen(true)} type="button">
                  Leaderboard
                </button>
              </div>


              {phase === "over" && canChain && (
                <div className="dwRow">
                  <button
                    className={"dwBtn " + (account ? "dwPrimary" : "")}
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

{lbOpen && (
          <div className="dwOverlay dwOverlayTop" onClick={() => setLbOpen(false)}>
            <div className="dwModal" onClick={(e) => e.stopPropagation()}>
              <div className="dwModalTitle">Weekly Leaderboard</div>

              <div className="dwLbMeta">
                <div>
                  <span>Week</span>
                  <b>#{lbWeekId ?? "—"}</b>
                  {lbCurrentWeekId != null && lbWeekId != null && lbWeekId !== lbCurrentWeekId && (
                    <em className="dwLbTag">Snapshot</em>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <span>
                    {lbCurrentWeekId != null && lbWeekId != null && lbWeekId !== lbCurrentWeekId ? "Ended" : "Resets in"}
                  </span>
                  <b>
                    {lbCurrentWeekId != null && lbWeekId != null && lbWeekId !== lbCurrentWeekId
                      ? "—"
                      : lbEndMs
                        ? fmtLeft(lbEndMs - lbNow)
                        : "…"}
                  </b>
                </div>
              </div>

              <div className="dwLbSwitch">
                {lbCurrentWeekId != null && lbWeekId != null && lbWeekId !== lbCurrentWeekId && (
                  <button className="dwBtn" onClick={() => loadLeaderboard()}>
                    This week
                  </button>
                )}
                {process.env.NODE_ENV !== "production" && (
                  <button
                    className="dwBtn"
                    onClick={async () => {
                      await fetch("/api/leaderboard/reset", { method: "POST" });
                      loadLeaderboard();
                    }}
                    title="Development helper: clears the current week scores"
                  >
                    Reset (dev)
                  </button>
                )}
                {lbUpdating && <div className="dwLbUpdating">Updating…</div>}
              </div>

              {typeof lbMyRank === "number" && (
                <div className="dwHint">Your rank: #{lbMyRank}</div>
              )}

              {lbKvEnabled === false && (
                <div className="dwHint">
                  Leaderboard storage is running in local memory. Configure KV_REST_API_URL/KV_REST_API_TOKEN (Vercel KV) or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (personal Upstash) to persist weekly rankings.
                </div>
              )}

              <div className="dwLbCard">
                <div className="dwLbHeadRow">
                  <span>#</span>
                  <span>Player</span>
                  <span style={{ textAlign: "right" }}>Score</span>
                </div>

                <div className="dwLbList">
                  {lbLoading ? (
                    <div className="dwLbEmpty">Loading…</div>
                  ) : lbErr ? (
                    <div className="dwLbEmpty">{lbErr}</div>
                  ) : lbTop.length === 0 ? (
                    <div className="dwLbEmpty">No scores yet. Be the first.</div>
                  ) : (
                    lbTop.map((e, i) => (
                      <div className="dwLbRow" key={e.address + i}>
                        <span className="dwLbRank">{i + 1}</span>
                        <span className="dwLbAddr">{e.address.slice(0, 6)}…{e.address.slice(-4)}</span>
                        <span className="dwLbScore">{e.score}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="dwRow">
                <button className="dwBtn dwPrimary" onClick={() => setLbOpen(false)} type="button">
                  Back
                </button>
                <button
                  className="dwBtn"
                  onClick={() => {
                    const viewingPast = lbCurrentWeekId != null && lbWeekId != null && lbCurrentWeekId !== lbWeekId;
                    loadLeaderboard(viewingPast ? lbWeekId! : undefined);
                  }}
                  type="button"
                >
                  Refresh
                </button>
              </div>
            </div>
          </div>
        )}

        {walletPickerOpen && (
          <div className="dwOverlay dwOverlayTop" onClick={closeWalletPicker}>
            <div className="dwModal" onClick={(e) => e.stopPropagation()}>
              <div className="dwModalTitle">Choose wallet</div>
              <div className="dwNote">
                Multiple injected wallets were detected in your browser. Select the one you want to connect with.
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
                {injectedWalletOptions.map((w) => (
                  <button
                    key={w.id}
                    className="dwBtn"
                    type="button"
                    onClick={() => chooseInjectedWallet(w)}
                    style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-start" }}
                  >
                    {w.icon ? (
                      // EIP-6963 icons are usually data URIs.
                      <img src={w.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />
                    ) : (
                      <span style={{ width: 18, display: "inline-block", opacity: 0.8 }}>◦</span>
                    )}
                    <span>{w.name}</span>
                  </button>
                ))}
              </div>

              <div className="dwRow" style={{ justifyContent: "flex-end" }}>
                <button className="dwBtn" type="button" onClick={closeWalletPicker}>
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
