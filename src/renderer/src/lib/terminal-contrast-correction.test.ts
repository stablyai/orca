import { describe, expect, it } from 'vitest'
import {
  DARK_BG_MIN_CONTRAST,
  LIGHT_BG_MIN_CONTRAST,
  resolveTerminalMinimumContrastRatio
} from './terminal-contrast-correction'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'

// WCAG relative-luminance contrast ratio, matching xterm's minimumContrastRatio gate.
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = Number.parseInt(hex.replace('#', ''), 16)
    const toLinear = (channel: number): number => {
      const c = channel / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const r = toLinear((n >> 16) & 0xff)
    const g = toLinear((n >> 8) & 0xff)
    const bl = toLinear(n & 0xff)
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const la = lum(a)
  const lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('resolveTerminalMinimumContrastRatio', () => {
  it('returns the light-background floor for a light terminal background', () => {
    expect(resolveTerminalMinimumContrastRatio('#ffffff', 'light')).toBe(LIGHT_BG_MIN_CONTRAST)
  })

  it('returns the dark-background floor for a dark terminal background', () => {
    expect(resolveTerminalMinimumContrastRatio('#1e242a', 'dark')).toBe(DARK_BG_MIN_CONTRAST)
  })

  it('follows the composed background, not the app surface (light theme in the dark slot)', () => {
    expect(resolveTerminalMinimumContrastRatio('#fbf1c7', 'dark')).toBe(LIGHT_BG_MIN_CONTRAST)
  })

  it('treats an undefined/transparent background as dark', () => {
    expect(resolveTerminalMinimumContrastRatio(undefined, 'dark')).toBe(DARK_BG_MIN_CONTRAST)
  })
})

// #10104: the dark-background floor must sit in the window that rescues near-background body text
// without over-brightening vibrant ANSI colors (the #7934 regression). Guarding both edges keeps a
// future tweak from silently sliding out of that window.
describe('DARK_BG_MIN_CONTRAST rescue window', () => {
  const DARK_BG = '#1e242a'

  it('is high enough to lift Antigravity-style near-background body text', () => {
    // #262b30 on #1e242a is ~1.1:1 — invisible at floor 1. The floor must exceed it so xterm corrects it.
    expect(contrastRatio(DARK_BG, '#262b30')).toBeLessThan(DARK_BG_MIN_CONTRAST)
  })

  it('stays below the contrast that saturated ANSI colors naturally reach on a dark background', () => {
    // Normal red/blue/magenta sit at ~3.0-3.4:1 here; the floor must not exceed them or xterm would
    // wash them toward white — exactly the over-brightening #7934 disabled the 4.5 floor to avoid.
    for (const ansi of ['#cd3131', '#2472c8', '#bc3fbc']) {
      expect(contrastRatio(DARK_BG, ansi)).toBeGreaterThanOrEqual(DARK_BG_MIN_CONTRAST)
    }
  })
})

// #10104: pin which real builtin dark themes have normal ANSI colors below the floor, so a new theme
// or floor tweak forces an explicit decision instead of a silent #7934-style regression.
describe('DARK_BG_MIN_CONTRAST vs the builtin theme catalog', () => {
  // Normal (non-bright) chromatic ANSI channels — the vibrant body-text colors #7934 protects.
  // Bright variants are excluded: several themes (e.g. Solarized) repurpose them as achromatic grays.
  const CHROMATIC_ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

  // Accepted below-floor cases: near-illegible primaries on very dark backgrounds where the mild
  // lift helps rather than harms. Keep in sync with the comment in terminal-contrast-correction.ts.
  const ACCEPTED_BELOW_FLOOR = ['Gruvbox Dark:red', 'Homebrew:blue', 'Homebrew:red']

  it('leaves every dark-theme chromatic ANSI color at/above the floor, except the pinned exceptions', () => {
    const belowFloor: string[] = []
    for (const [name, theme] of Object.entries(TERMINAL_THEME_CATALOG)) {
      const background = theme.background
      // Only dark-slot themes get the dark floor; the resolver picks it exactly for those.
      if (
        !background ||
        resolveTerminalMinimumContrastRatio(background, 'dark') !== DARK_BG_MIN_CONTRAST
      ) {
        continue
      }
      for (const channel of CHROMATIC_ANSI) {
        const color = theme[channel]
        if (color && contrastRatio(background, color) < DARK_BG_MIN_CONTRAST) {
          belowFloor.push(`${name}:${channel}`)
        }
      }
    }
    expect(belowFloor.sort()).toEqual(ACCEPTED_BELOW_FLOOR)
  })
})
