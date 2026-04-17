/* tslint:disable */
/* eslint-disable */

export class GameEngine {
    free(): void;
    [Symbol.dispose](): void;
    get_state(): any;
    constructor();
    reset(phase_str: string, diff_str: string, time: number): void;
    resize(w: number, h: number, dpr: number): void;
    set_target_x(x: number): void;
    update(time: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_gameengine_free: (a: number, b: number) => void;
    readonly gameengine_get_state: (a: number) => any;
    readonly gameengine_new: () => number;
    readonly gameengine_reset: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly gameengine_resize: (a: number, b: number, c: number, d: number) => void;
    readonly gameengine_set_target_x: (a: number, b: number) => void;
    readonly gameengine_update: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
