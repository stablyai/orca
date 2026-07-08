// Settings resolution for STA-1282 terminal pane eviction. Kept as a pure
// shared module so the renderer policy, the settings UI, and the main/runtime
// hosts resolve the same defaults and clamps without importing renderer code.

// Experimental, opt-in, default OFF (Brennan, design review: field risk 9/10).
// Follows the agent-hibernation precedent exactly.
export const TERMINAL_PANE_EVICTION_DEFAULT_ENABLED = false

export const TERMINAL_PANE_EVICTION_WARM_BUDGET_DEFAULT = 12
export const TERMINAL_PANE_EVICTION_WARM_BUDGET_MIN = 4
export const TERMINAL_PANE_EVICTION_WARM_BUDGET_MAX = 64

export const TERMINAL_PANE_EVICTION_AFTER_MINUTES_DEFAULT = 5
export const TERMINAL_PANE_EVICTION_AFTER_MINUTES_MIN = 1
export const TERMINAL_PANE_EVICTION_AFTER_MINUTES_MAX = 120

// Why: a self-disable trips after this many *structural* replay failures in a
// session (RPC error/timeout, malformed snapshot) — never on a legitimately
// blank/nil mirror. See remount step 5 / gate #5.
export const TERMINAL_PANE_EVICTION_MAX_REPLAY_FAILURES = 3

// Why: bound the eviction-remount main-buffer snapshot request. A never-resolving
// getMainBufferSnapshot on an evicted remount would otherwise keep the pane
// history-blank forever without charging the fail-open counter; on timeout the
// pane falls open to live and the structural-failure counter is charged (gate #5).
export const TERMINAL_PANE_EVICTION_REMOUNT_SNAPSHOT_TIMEOUT_MS = 10_000

type EvictionSettingsInput = {
  experimentalTerminalPaneEviction?: boolean
  terminalPaneEvictionWarmBudget?: number
  terminalPaneEvictionAfterMinutes?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Why: older persisted settings objects predate these keys. `?? default`
 * hydration (STA-5082 lesson) keeps them on the documented defaults (eviction
 * OFF, warm budget 12, dwell 5 min), and clamps out-of-range persisted values.
 */
export function isTerminalPaneEvictionEnabled(settings: EvictionSettingsInput | null): boolean {
  return settings?.experimentalTerminalPaneEviction ?? TERMINAL_PANE_EVICTION_DEFAULT_ENABLED
}

export function resolveTerminalPaneEvictionWarmBudget(
  settings: EvictionSettingsInput | null
): number {
  const raw = settings?.terminalPaneEvictionWarmBudget
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return TERMINAL_PANE_EVICTION_WARM_BUDGET_DEFAULT
  }
  return clamp(
    Math.round(raw),
    TERMINAL_PANE_EVICTION_WARM_BUDGET_MIN,
    TERMINAL_PANE_EVICTION_WARM_BUDGET_MAX
  )
}

export function resolveTerminalPaneEvictionAfterMs(settings: EvictionSettingsInput | null): number {
  const raw = settings?.terminalPaneEvictionAfterMinutes
  const minutes =
    typeof raw === 'number' && Number.isFinite(raw)
      ? clamp(
          Math.round(raw),
          TERMINAL_PANE_EVICTION_AFTER_MINUTES_MIN,
          TERMINAL_PANE_EVICTION_AFTER_MINUTES_MAX
        )
      : TERMINAL_PANE_EVICTION_AFTER_MINUTES_DEFAULT
  return minutes * 60_000
}
