import { describe, expect, it } from 'vitest'
import {
  isTerminalPaneEvictionEnabled,
  resolveTerminalPaneEvictionAfterMs,
  resolveTerminalPaneEvictionWarmBudget,
  TERMINAL_PANE_EVICTION_AFTER_MINUTES_DEFAULT,
  TERMINAL_PANE_EVICTION_WARM_BUDGET_DEFAULT
} from './terminal-pane-eviction-settings'

// Gate #7 (startup-upgrade.persisted-session-corpus): older persisted settings
// without the new keys must hydrate to defaults (STA-5082 lesson), and
// out-of-range persisted values must clamp.
describe('terminal-pane-eviction settings hydration', () => {
  it('defaults OFF (experimental, opt-in) when the key is absent (older settings)', () => {
    expect(isTerminalPaneEvictionEnabled(null)).toBe(false)
    expect(isTerminalPaneEvictionEnabled({})).toBe(false)
  })

  it('respects an explicit opt-in', () => {
    expect(isTerminalPaneEvictionEnabled({ experimentalTerminalPaneEviction: true })).toBe(true)
    expect(isTerminalPaneEvictionEnabled({ experimentalTerminalPaneEviction: false })).toBe(false)
  })

  it('defaults the warm budget when absent and clamps out-of-range values', () => {
    expect(resolveTerminalPaneEvictionWarmBudget(null)).toBe(
      TERMINAL_PANE_EVICTION_WARM_BUDGET_DEFAULT
    )
    expect(resolveTerminalPaneEvictionWarmBudget({ terminalPaneEvictionWarmBudget: 1 })).toBe(4)
    expect(resolveTerminalPaneEvictionWarmBudget({ terminalPaneEvictionWarmBudget: 999 })).toBe(64)
    expect(resolveTerminalPaneEvictionWarmBudget({ terminalPaneEvictionWarmBudget: 20 })).toBe(20)
  })

  it('rejects a non-finite persisted budget and falls back to default', () => {
    expect(
      resolveTerminalPaneEvictionWarmBudget({ terminalPaneEvictionWarmBudget: Number.NaN })
    ).toBe(TERMINAL_PANE_EVICTION_WARM_BUDGET_DEFAULT)
  })

  it('defaults the dwell when absent and clamps minutes 1-120', () => {
    expect(resolveTerminalPaneEvictionAfterMs(null)).toBe(
      TERMINAL_PANE_EVICTION_AFTER_MINUTES_DEFAULT * 60_000
    )
    expect(resolveTerminalPaneEvictionAfterMs({ terminalPaneEvictionAfterMinutes: 0 })).toBe(
      1 * 60_000
    )
    expect(resolveTerminalPaneEvictionAfterMs({ terminalPaneEvictionAfterMinutes: 9999 })).toBe(
      120 * 60_000
    )
    expect(resolveTerminalPaneEvictionAfterMs({ terminalPaneEvictionAfterMinutes: 5 })).toBe(
      5 * 60_000
    )
  })
})
