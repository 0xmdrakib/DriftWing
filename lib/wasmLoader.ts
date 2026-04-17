/**
 * Thin wrapper that dynamically loads the Rust WASM game-engine at runtime
 * from /wasm/ (served by Next.js as a static public asset).
 *
 * Usage:
 *   const { GameEngine } = await loadEngine();
 *   const engine = new GameEngine();
 */

type GameEngineClass = {
  new (): GameEngineInstance;
};

export type GameEngineInstance = {
  free(): void;
  get_state(): any;
  reset(phase_str: string, diff_str: string, time: number): void;
  resize(w: number, h: number, dpr: number): void;
  set_target_x(x: number): void;
  update(time: number): void;
};

let cached: { GameEngine: GameEngineClass } | null = null;

export async function loadEngine(): Promise<{ GameEngine: GameEngineClass }> {
  if (cached) return cached;

  // Dynamic import of the wasm-pack generated JS (lives in public/wasm/).
  // We use webpackIgnore + @ts-ignore so webpack and TypeScript both skip this —
  // the file only exists at runtime as a static asset served from /wasm/.
  // @ts-ignore — runtime-only dynamic import from public directory
  const wasmModule = await import(/* webpackIgnore: true */ "/wasm/wasm_engine.js");

  // init() fetches the .wasm binary from the same directory by default.
  await wasmModule.default("/wasm/wasm_engine_bg.wasm");

  cached = { GameEngine: wasmModule.GameEngine };
  return cached;
}
