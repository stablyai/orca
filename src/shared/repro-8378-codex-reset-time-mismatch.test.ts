/**
 * Issue #8378 — Codex session reset time mismatch (popup vs bottom status bar).
 *
 * Root cause: two different fields drive the two surfaces for the same
 * RateLimitWindow:
 *   - Status-bar chip label uses formatWindowLabel(windowMinutes) → fixed
 *     bucket size ("5h" for Codex's 300-minute session window).
 *   - Popup/tooltip uses formatResetCountdown(resetsAt - now) → remaining
 *     time until the actual reset ("2h 33m").
 *
 * Reporter saw popup "2h 33m" vs bar "5h" — exactly this divergence.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/shared/repro-8378-codex-reset-time-mismatch.test.ts
 */
import { describe, expect, it } from 'vitest'
import { formatResetCountdown, formatResetDuration } from './rate-limit-reset-format'
import { formatWindowLabel } from '../renderer/src/lib/window-label-formatter'
import type { RateLimitWindow } from './rate-limit-types'

describe('#8378 Codex session reset time: chip vs popup diverge', () => {
  it('chip shows fixed window size "5h" while popup shows remaining "2h 33m"', () => {
    const remainingMs = 2 * 60 * 60_000 + 33 * 60_000 // 2h 33m
    // Use a fixed resetsAt so Date.now() drift between calls cannot flake.
    const resetsAt = 1_800_000_000_000
    const now = resetsAt - remainingMs
    const session: RateLimitWindow = {
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt,
      resetDescription: null
    }

    // Bottom status bar WindowLabel: formatWindowLabel(session.windowMinutes)
    const chipLabel = formatWindowLabel(session.windowMinutes)
    expect(chipLabel).toBe('5h')

    // Popup PanelWindowSection: formatResetCountdown(session.resetsAt - now)
    const popupLabel = formatResetCountdown(session.resetsAt! - now)
    expect(popupLabel).toBe('Resets in 2h 33m')

    // Same input, different surfaces, different numbers — the bug.
    expect(chipLabel).not.toBe(formatResetDuration(remainingMs))
    expect(formatResetDuration(remainingMs)).toBe('2h 33m')
  })

  it('diverges for any remaining time that is not the full window', () => {
    const cases = [
      { remainingMs: 47 * 60_000, remaining: '47m', window: '5h' },
      { remainingMs: 3 * 60 * 60_000 + 54 * 60_000, remaining: '3h 54m', window: '5h' },
      { remainingMs: 1 * 60_000, remaining: '1m', window: '5h' }
    ] as const

    for (const c of cases) {
      const resetsAt = 1_800_000_000_000
      const session: RateLimitWindow = {
        usedPercent: 40,
        windowMinutes: 300,
        resetsAt,
        resetDescription: null
      }
      expect(formatWindowLabel(session.windowMinutes)).toBe(c.window)
      expect(formatResetDuration(resetsAt - (resetsAt - c.remainingMs))).toBe(c.remaining)
    }
  })

  it('only agrees when remaining time happens to equal the full window size', () => {
    const fullWindowMs = 300 * 60_000
    const resetsAt = 1_800_000_000_000
    const now = resetsAt - fullWindowMs
    const session: RateLimitWindow = {
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt,
      resetDescription: null
    }
    // Chip is always "5h"; countdown is "5h" only at the moment the window
    // just started — still different strings ("5h" vs "Resets in 5h").
    expect(formatWindowLabel(session.windowMinutes)).toBe('5h')
    expect(formatResetCountdown(session.resetsAt! - now)).toBe('Resets in 5h')
  })
})
