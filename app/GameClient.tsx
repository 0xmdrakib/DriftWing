"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import { hasScoreboard, readBestScore, submitScore, waitForReceipt } from "@/lib/chain";
import { getEthereumProvider } from "@/lib/ethProvider";

type Phase = "menu" | "play" | "over";
type Difficulty = "easy" | "medium" | "hard";
type EnemyType = "scout" | "zigzag" | "tank" | "boss";

type Enemy = {
  id: number;
  t: EnemyType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hp: number;
  maxHp: number;
};

type Bullet = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Smooth 0..1 easing to avoid "sudden" difficulty spikes.
function smoothstep01(x: number) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
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

const DIFF: Record<
  Difficulty,
  {
    label: string;
    // How long the difficulty ramps up (ms). Easy ramps slower; hard ramps faster.
    rampMs: number;
    // spawn pacing
    spawnBaseMs: number;
    spawnMinFactor: number; // ramps down to base*factor
    // speed multiplier
    speedMul: number;
    // hp multiplier for non-boss
    hpMul: number;
    // player fire interval
    fireIntervalMs: number;
    // boss
    bossEveryMs: number;
    bossHp: number;
    bossDamageMul: number; // bullets do extra damage vs boss
  }
> = {
  easy: {
    label: "Easy",
    rampMs: 140_000,
    // fewer spawns, slower ramp
    spawnBaseMs: 1400,
    spawnMinFactor: 0.86,
    // slower enemies
    speedMul: 0.80,
    // less HP (more forgiving)
    hpMul: 0.85,
    // faster fire
    fireIntervalMs: 78,
    // boss appears later and is weaker
    bossEveryMs: 70_000,
    bossHp: 6,
    bossDamageMul: 1.2,
  },
  medium: {
    label: "Medium",
    rampMs: 115_000,
    spawnBaseMs: 1150,
    spawnMinFactor: 0.78,
    speedMul: 0.92,
    hpMul: 0.98,
    fireIntervalMs: 86,
    bossEveryMs: 62_000,
    bossHp: 9,
    bossDamageMul: 1.25,
  },
  hard: {
    label: "Hard",
    rampMs: 95_000,
    spawnBaseMs: 980,
    spawnMinFactor: 0.70,
    speedMul: 1.0,
    hpMul: 1.05,
    fireIntervalMs: 96,
    bossEveryMs: 55_000,
    bossHp: 12,
    bossDamageMul: 1.3,
  },
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

  const [scoreUi, setScoreUi] = useState(0);
  const [bestUi, setBestUi] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("");

  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [saving, setSaving] = useState(false);
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
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load leaderboard");
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

  const g = useRef({
    w: 0,
    h: 0,
    dpr: 1,

    startAt: 0,
    lastAt: 0,

    // player
    px: 0,
    py: 0,
    tx: 0,
    dragging: false,

    // entities
    enemies: [] as Enemy[],
    bullets: [] as Bullet[],

    // pacing
    nextSpawnAt: 0,
    nextBossAt: 0,
    lastShotAt: 0,

    // score
    score: 0,

    // boosts
    overdriveUntil: 0,

    // ids
    id: 1,
  });

  function setPhaseSafe(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  async function connect() {
    try {
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
    } catch (e: any) {
      setStatus(e?.message || "Wallet connect failed");
    }
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

  function resetCore() {
    const gg = g.current;
    gg.enemies = [];
    gg.bullets = [];
    gg.id = 1;
    gg.score = 0;
    gg.overdriveUntil = 0;
    gg.nextSpawnAt = performance.now() + 450;
    gg.nextBossAt = performance.now() + DIFF[difficultyRef.current].bossEveryMs;
    gg.lastShotAt = 0;
    saveLockRef.current = false;
    setSavedThisRun(false);
    setLbOpen(false);
    setStatus("");
    setScoreUi(0);
  }

  function restart(into: Phase) {
    resetCore();
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

      gg.py = Math.floor(gg.h * 0.86);
      gg.px = Math.floor(gg.w * 0.5);
      gg.tx = gg.px;
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

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
    const drawStars = (ctx: CanvasRenderingContext2D, t: number) => {
      ctx.save();
      ctx.globalAlpha = 0.35;
      for (let i = 0; i < 30; i++) {
        const x = (((i * 97) % 1013) / 1013) * gg.w;
        const y = (((i * 173 + t * 0.03) % 997) / 997) * gg.h;
        ctx.fillStyle = "rgba(234,240,255,.65)";
        ctx.fillRect(x, y, 1.2 * gg.dpr, 1.2 * gg.dpr);
      }
      ctx.restore();
    };

    // Plane silhouette drawn pointing UP (nose up). Rotate by PI for down-facing.
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

      // Soft shadow so the jet pops on dark backgrounds
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;

      // Jet silhouette (classic top-down plane icon)
      const g = ctx.createLinearGradient(0, -30, 0, 26);
      g.addColorStop(0, fill);
      g.addColorStop(1, "rgba(255,255,255,0.08)");
      ctx.fillStyle = g;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2;

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

      // Cockpit (simple glossy oval)
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(0, -13, 4.2, 8.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Thruster (only for player + boss to feel alive)
      if (flame) {
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = "rgba(80, 255, 214, 0.20)";
        ctx.beginPath();
        ctx.ellipse(0, 22, 7.5, 5.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.beginPath();
        ctx.ellipse(0, 18, 5.5, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.restore();
    };
    const drawBullet = (ctx: CanvasRenderingContext2D, b: Bullet) => {
      ctx.save();
      ctx.translate(b.x, b.y);

      // Speed lines (behind the missile)
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-6, 10); ctx.lineTo(-6, 18);
      ctx.moveTo(0, 12); ctx.lineTo(0, 22);
      ctx.moveTo(6, 10); ctx.lineTo(6, 18);
      ctx.stroke();

      // Missile body
      ctx.shadowColor = "rgba(0,0,0,0.25)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 1;

      // capsule-ish body
      roundRectPath(ctx, -5, -14, 10, 24, 5);
      ctx.fill();
      ctx.stroke();

      // nose highlight
      ctx.shadowBlur = 0;
      const hg = ctx.createLinearGradient(0, -14, 0, -2);
      hg.addColorStop(0, "rgba(255,255,255,0.75)");
      hg.addColorStop(1, "rgba(255,255,255,0.0)");
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.ellipse(0, -10, 3.2, 4.6, 0, 0, Math.PI * 2);
      ctx.fill();

      // tail fins
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(-5, 6); ctx.lineTo(-10, 12); ctx.lineTo(-5, 12); ctx.closePath();
      ctx.moveTo(5, 6);  ctx.lineTo(10, 12);  ctx.lineTo(5, 12);  ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.stroke();

      ctx.restore();
    };

    const pickEnemyType = (r: number, diff: Difficulty): EnemyType => {
      // Distribution tuned so Easy is truly forgiving and Hard is challenging but fair.
      if (diff === "easy") {
        if (r < 0.72) return "scout";
        if (r < 0.95) return "zigzag";
        return "tank";
      }
      if (diff === "medium") {
        if (r < 0.62) return "scout";
        if (r < 0.92) return "zigzag";
        return "tank";
      }
      // hard
      if (r < 0.55) return "scout";
      if (r < 0.88) return "zigzag";
      return "tank";
    };

    const spawnEnemy = (t: number) => {
      const d = DIFF[difficultyRef.current];
      const rampRaw = (t - gg.startAt) / d.rampMs;
      const ramp = smoothstep01(rampRaw);
      const spawnMs = d.spawnBaseMs * (1 - (1 - d.spawnMinFactor) * ramp);

      gg.nextSpawnAt = t + spawnMs;

      const et = pickEnemyType(Math.random(), difficultyRef.current);
      const x = clamp(Math.random() * gg.w, 30 * gg.dpr, gg.w - 30 * gg.dpr);

      let hp = 1;
      let r = 14 * gg.dpr;
      // Base speed + gentle ramp (smoothstep) to keep the game "smooth" and predictable.
      let vy = (220 + 180 * ramp) * gg.dpr * d.speedMul;
      let vx = 0;

      if (et === "scout") {
        hp = Math.max(1, Math.round(1 * d.hpMul));
        r = 14 * gg.dpr;
        vy *= 1.08;
      } else if (et === "zigzag") {
        hp = Math.max(1, Math.round(1 * d.hpMul));
        r = 15 * gg.dpr;
        vy *= 0.95;
        vx = (Math.random() < 0.5 ? -1 : 1) * (120 + 100 * ramp) * gg.dpr * d.speedMul;
      } else if (et === "tank") {
        hp = Math.max(2, Math.round(2 * d.hpMul));
        r = 17 * gg.dpr;
        vy *= 0.80;
      }

      gg.enemies.push({
        id: gg.id++,
        t: et,
        x,
        y: -44 * gg.dpr,
        vx,
        vy,
        r,
        hp,
        maxHp: hp,
      });
    };

    const spawnBoss = (t: number) => {
      const d = DIFF[difficultyRef.current];
      gg.nextBossAt = t + d.bossEveryMs;

      const hp = d.bossHp;
      gg.enemies.push({
        id: gg.id++,
        t: "boss",
        x: gg.w * 0.5,
        y: -70 * gg.dpr,
        vx: 0,
        vy: 120 * gg.dpr * d.speedMul,
        r: 36 * gg.dpr,
        hp,
        maxHp: hp,
      });
    };

    const shoot = (t: number) => {
      const d = DIFF[difficultyRef.current];
      const overdrive = t < gg.overdriveUntil;
      const interval = overdrive ? Math.max(66, d.fireIntervalMs - 26) : d.fireIntervalMs;

      if (t - gg.lastShotAt < interval) return;
      gg.lastShotAt = t;

      const speed = -920 * gg.dpr;
      const dual = overdrive; // Overdrive => double bullets
      const spread = dual ? 10 * gg.dpr : 0;

      gg.bullets.push({
        id: gg.id++,
        x: gg.px - spread,
        y: gg.py - 26 * gg.dpr,
        vx: 0,
        vy: speed,
      });
      if (dual) {
        gg.bullets.push({
          id: gg.id++,
          x: gg.px + spread,
          y: gg.py - 26 * gg.dpr,
          vx: 0,
          vy: speed,
        });
      }
    };

    // UI throttle
    let lastUi = performance.now();

    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dt = Math.min(0.033, (t - gg.lastAt) / 1000);
      gg.lastAt = t;

      // Update
      if (phaseRef.current === "play") {
        // smooth drift (a bit snappier on Easy, still smooth everywhere)
        const follow = difficultyRef.current === "easy" ? 15 : difficultyRef.current === "medium" ? 14 : 13;
        gg.px += (gg.tx - gg.px) * clamp(dt * follow, 0, 1);

        // auto-fire always (no heat HUD)
        shoot(t);

        // spawn enemies
        if (t >= gg.nextSpawnAt) spawnEnemy(t);

        // boss spawn
        const bossAlive = gg.enemies.some((e) => e.t === "boss");
        if (!bossAlive && t >= gg.nextBossAt) spawnBoss(t);

        // move bullets
        for (const b of gg.bullets) {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
        gg.bullets = gg.bullets.filter((b) => b.y > -60 * gg.dpr);

        // move enemies
        for (const e of gg.enemies) {
          if (e.t === "boss") {
            const targetY = 120 * gg.dpr;
            if (e.y < targetY) e.y += e.vy * dt;
            else e.y += Math.sin(t * 0.002) * 9 * gg.dpr * dt;

            // gentle side movement
            e.x = gg.w * 0.5 + Math.sin(t * 0.0012) * (gg.w * 0.18);
          } else {
            e.y += e.vy * dt;
            e.x += e.vx * dt;

            if (e.t === "zigzag") {
              if (e.x < 24 * gg.dpr || e.x > gg.w - 24 * gg.dpr) {
                e.vx *= -1;
                e.x = clamp(e.x, 24 * gg.dpr, gg.w - 24 * gg.dpr);
              }
            }
          }
        }

        // If any enemy touches the bottom edge => game over.
        for (const e of gg.enemies) {
          if (e.y + e.r >= gg.h) {
            endGame();
            break;
          }
        }

        if (phaseRef.current === "play") {
          // collisions: bullets -> enemies
        const d = DIFF[difficultyRef.current];
        const bulletAlive: Bullet[] = [];
        for (const b of gg.bullets) {
          let hit = false;
          for (const e of gg.enemies) {
            const rr = (e.t === "boss" ? 0.85 : 0.92) * e.r + 6 * gg.dpr;
            if (dist2(b.x, b.y, e.x, e.y) <= rr * rr) {
              hit = true;

              // damage
              const dmg = e.t === "boss" ? d.bossDamageMul : 1;
              e.hp -= dmg;

              if (e.hp <= 0) {
                // kill reward
                if (e.t === "boss") {
                  gg.score += 520;
                  gg.overdriveUntil = t + 6500; // reward boost
                } else if (e.t === "tank") {
                  gg.score += 35;
                } else {
                  gg.score += 20;
                }
              } else {
                // small hit points
                gg.score += e.t === "boss" ? 2 : 1;
              }
              break;
            }
          }
          if (!hit) bulletAlive.push(b);
        }
        gg.bullets = bulletAlive;

        // remove dead/out enemies
        gg.enemies = gg.enemies.filter((e) => e.hp > 0 && e.y < gg.h + 100 * gg.dpr);

        // player collision -> game over
        for (const e of gg.enemies) {
          // More accurate hit feel (less "unfair"). We treat both as soft circles.
          const playerHitR = 13 * gg.dpr;
          const enemyHitR = e.t === "boss" ? e.r * 0.82 : e.r * 0.90;
          const rr = enemyHitR + playerHitR;
          if (dist2(gg.px, gg.py, e.x, e.y) <= rr * rr) {
            endGame();
            break;
          }
        }

        }
      }

      // Draw
      ctx.clearRect(0, 0, gg.w, gg.h);

      drawStars(ctx, t);

      // subtle vignette
      ctx.save();
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.beginPath();
      ctx.ellipse(gg.w * 0.5, gg.h * 0.55, gg.w * 0.65, gg.h * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // enemies
      for (const e of gg.enemies) {
        const tilt = e.t === "zigzag" ? Math.sin(t * 0.01) * 0.18 : 0;

        if (e.t === "boss") {
          drawPlane(
            ctx,
            e.x,
            e.y,
            1.35 * gg.dpr,
            "rgba(255,92,122,.16)",
            "rgba(255,92,122,.55)",
            false,
            tilt,
            true
          );

          // boss HP bar
          const w = 150 * gg.dpr;
          const h = 10 * gg.dpr;
          const x = e.x - w / 2;
          const y = e.y - 60 * gg.dpr;

          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "rgba(255,255,255,.10)";
          roundRectPath(ctx, x, y, w, h, 999);
          ctx.fill();

          const frac = clamp(e.hp / e.maxHp, 0, 1);
          ctx.fillStyle = "rgba(255,92,122,.85)";
          roundRectPath(ctx, x, y, w * frac, h, 999);
          ctx.fill();

          ctx.restore();
        } else {
          let fill = "rgba(234,240,255,.10)";
          let stroke = "rgba(234,240,255,.35)";
          if (e.t === "scout") {
            fill = "rgba(124,255,178,.10)";
            stroke = "rgba(124,255,178,.55)";
          } else if (e.t === "zigzag") {
            fill = "rgba(255,209,102,.10)";
            stroke = "rgba(255,209,102,.55)";
          } else if (e.t === "tank") {
            fill = "rgba(160,170,255,.10)";
            stroke = "rgba(160,170,255,.55)";
          }

          drawPlane(ctx, e.x, e.y, 1.05 * gg.dpr, fill, stroke, false, tilt, true);
        }
      }

      // bullets
      for (const b of gg.bullets) drawBullet(ctx, b);

      // player plane
      const flame = phaseRef.current === "play";
      const playerTilt = (gg.tx - gg.px) / (gg.w * 0.45);
      drawPlane(
        ctx,
        gg.px,
        gg.py,
        1.15 * gg.dpr,
        "rgba(234,240,255,.92)",
        "rgba(234,240,255,.50)",
        flame,
        clamp(playerTilt, -0.22, 0.22),
        false
      );

      // update UI
      if (t - lastUi >= 90) {
        lastUi = t;
        setScoreUi(Math.floor(gg.score));
      }
    };

    gg.startAt = performance.now();
    gg.lastAt = gg.startAt;
    gg.nextSpawnAt = gg.startAt + 500;
    gg.nextBossAt = gg.startAt + DIFF[difficultyRef.current].bossEveryMs;

    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // We intentionally exclude `difficulty` from deps: we update pacing on restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="dw">
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
          {/* Difficulty (dropdown) */}
          <div className="dwDiffMenu" ref={diffWrapRef}>
            <button
              className="dwBtn dwDiffSelect"
              type="button"
              onClick={() => setDiffOpen((v) => !v)}
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
          <button
            className="dwBtn dwIconBtn"
            onClick={() => restart("play")}
            type="button"
            aria-label="Restart"
            title="Restart"
          >
            ↻
          </button>
          <button className="dwBtn dwPrimary" onClick={account ? () => {} : connect} type="button">
            {account ? acctShort : "Connect"}
          </button>
        </div>
      </div>

      <div className="dwStage">
        <canvas ref={canvasRef} className="dwCanvas" />

        {phase !== "play" && (
          <div className="dwOverlay">
            <div className="dwModal">
              <div className="dwModalTitle">{phase === "menu" ? "DriftWing" : "Game Over"}</div>
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
                  {phase === "menu" ? "Start" : "Play again"}
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
                {lbCurrentWeekId != null && lbCurrentWeekId > 0 && (
                  <button className="dwBtn" onClick={() => loadLeaderboard(lbCurrentWeekId - 1)}>
                    Last week
                  </button>
                )}
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
                  Leaderboard storage is running in local memory. Configure KV env vars on Vercel to persist weekly rankings.
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

        <div className="dwBottom">
          <div className="dwHow">
            Drag left/right to move • Auto-fire • Destroy the big plane for bonus + Overdrive
          </div>
          <div className="dwStatus">
            {saving ? "Saving…" : status}
          </div>
        </div>
      </div>
    </div>
  );
}
