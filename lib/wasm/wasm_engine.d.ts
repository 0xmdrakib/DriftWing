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
