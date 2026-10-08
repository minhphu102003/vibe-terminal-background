// Pure state machine: thinking/interactive resolution, dedupe, throttle,
// simulated-state override, and the idle fallback (spec §15.1, §15.5).

import type { VibeState } from '../config/settings';

export interface StateInput {
  state: VibeState;
  harness?: string;
  simulated?: boolean;
}

export interface StateEmit {
  state: VibeState;
  harness?: string;
  reason: 'event' | 'simulate' | 'idle-fallback' | 'real-event';
}

export interface StateMachineOptions {
  idleFallbackSec: number;
  throttleMs?: number;
  now?: () => number;
  onChange: (emit: StateEmit) => void;
  onTick?: (state: VibeState) => void;
}

export function isVibeState(v: unknown): v is VibeState {
  return v === 'thinking' || v === 'interactive';
}

export class StateMachine {
  private realState: VibeState = 'interactive';
  private override: VibeState | null = null;
  private lastRealEventAt: number;
  private lastEmitAt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  private idleFallbackMs: number;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly onChange: (emit: StateEmit) => void;
  private readonly onTick?: (state: VibeState) => void;

  constructor(opts: StateMachineOptions) {
    this.idleFallbackMs = Math.max(1, opts.idleFallbackSec) * 1000;
    this.throttleMs = opts.throttleMs ?? 80;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
    this.onTick = opts.onTick;
    this.lastRealEventAt = this.now();
    this.ticker = setInterval(() => this.tick(), 1000);
    // Do not keep the extension host alive just for the idle ticker.
    (this.ticker as { unref?: () => void }).unref?.();
  }

  get state(): VibeState {
    return this.override ?? this.realState;
  }

  get hasOverride(): boolean {
    return this.override !== null;
  }

  reconfigure(idleFallbackSec: number): void {
    this.idleFallbackMs = Math.max(1, idleFallbackSec) * 1000;
  }

  /** Feed a harness (or simulated) event. Returns the resolved state. */
  handle(input: StateInput): VibeState {
    if (this.disposed || !isVibeState(input.state)) return this.state;

    const before = this.state;
    if (input.simulated) {
      this.override = input.state;
    } else {
      // A real harness event always wins over a previous simulation.
      this.override = null;
      this.lastRealEventAt = this.now();
      this.realState = input.state;
    }

    const after = this.state;
    if (after !== before) {
      this.emit(input.harness, input.simulated ? 'simulate' : 'real-event');
    }
    return after;
  }

  private emit(harness: string | undefined, reason: StateEmit['reason']): void {
    const fire = () => {
      this.lastEmitAt = this.now();
      this.onChange({ state: this.state, harness, reason });
    };
    const gap = this.now() - this.lastEmitAt;
    if (gap >= this.throttleMs) {
      fire();
      return;
    }
    // Throttle: collapse rapid events into one emission at the boundary.
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (!this.disposed) fire();
    }, this.throttleMs - gap);
    (this.pendingTimer as { unref?: () => void }).unref?.();
  }

  private tick(): void {
    if (this.disposed) return;
    if (this.override === null && this.realState === 'thinking') {
      if (this.now() - this.lastRealEventAt >= this.idleFallbackMs) {
        this.realState = 'interactive';
        this.lastRealEventAt = this.now();
        this.emit(undefined, 'idle-fallback');
      }
    }
    this.onTick?.(this.state);
  }

  dispose(): void {
    this.disposed = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.ticker = null;
    this.pendingTimer = null;
  }
}
