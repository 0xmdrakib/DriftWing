/* @ts-self-types="./wasm_engine.d.ts" */
import * as wasm from "./wasm_engine_bg.wasm";
import { __wbg_set_wasm } from "./wasm_engine_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    GameEngine
} from "./wasm_engine_bg.js";
