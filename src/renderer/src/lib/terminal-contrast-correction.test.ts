import { describe, expect, it } from 'vitest'
import {
  DARK_BG_MIN_CONTRAST,
  DIM_TEXT_CONTRAST_HEADROOM,
  LIGHT_BG_MIN_CONTRAST,
  resolveTerminalMinimumContrastRatio
} from './terminal-contrast-correction'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'
import { resolveTerminalTextContrastRatio } from './terminal-title-contrast'

/** sRGB 0–255 channel → linear-light value per WCAG 2.x. */
function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return (
    0.2126 * toLinear((n >> 16) & 0xff) +
    0.7152 * toLinear((n >> 8) & 0xff) +
    0.0722 * toLinear(n & 0xff)
  )
}

/** WCAG relative-luminance contrast ratio, matching xterm's minimumContrastRatio gate. */
function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
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

// Dimmed palette text (ANSI 8: zsh-autosuggestions / fish ghost text, prompt hints) must stay visibly
// dimmer than body text. xterm lifts every below-floor color to the floor, so on a low-contrast light
// theme the floor lands beside the foreground and both collapse into one gray.
describe('resolveTerminalMinimumContrastRatio foreground headroom', () => {
  // Solarized Light (Warp/termio import): fg #586e75 is ~5.0:1, brightBlack #93a1a1 is ~2.5:1. At the
  // 4.5 floor xterm darkens brightBlack to #5f6868 — indistinguishable from the foreground.
  const SOLARIZED_LIGHT = { background: '#fdf6e3', foreground: '#586e75' }

  it('keeps the light floor when the foreground has plenty of contrast', () => {
    expect(resolveTerminalMinimumContrastRatio('#ffffff', 'light', '#000000')).toBe(
      LIGHT_BG_MIN_CONTRAST
    )
    expect(resolveTerminalMinimumContrastRatio('#fbf1c7', 'dark', '#3c3836')).toBe(
      LIGHT_BG_MIN_CONTRAST
    )
  })

  it('lowers the light floor to leave headroom below a low-contrast foreground', () => {
    const floor = resolveTerminalMinimumContrastRatio(
      SOLARIZED_LIGHT.background,
      'dark',
      SOLARIZED_LIGHT.foreground
    )
    const fgContrast = contrastRatio(SOLARIZED_LIGHT.background, SOLARIZED_LIGHT.foreground)
    expect(floor).toBeLessThan(LIGHT_BG_MIN_CONTRAST)
    expect(floor).toBeCloseTo(fgContrast / DIM_TEXT_CONTRAST_HEADROOM, 5)
  })

  it('keeps the ghost-text slot of a low-contrast theme at its designed contrast', () => {
    // Solarized Light ships brightBlack #93a1a1 at ~2.5:1; the floor must not lift it.
    const floor = resolveTerminalMinimumContrastRatio(
      SOLARIZED_LIGHT.background,
      'dark',
      SOLARIZED_LIGHT.foreground
    )
    expect(contrastRatio(SOLARIZED_LIGHT.background, '#93a1a1')).toBeGreaterThanOrEqual(
      floor - 0.05
    )
  })

  it('keeps the dark floor for a high-contrast dark theme', () => {
    expect(resolveTerminalMinimumContrastRatio('#1e242a', 'dark', '#e6edf3')).toBe(
      DARK_BG_MIN_CONTRAST
    )
  })

  it('lowers the dark floor too when the dark theme foreground is low-contrast', () => {
    // Solarized Dark: fg #839496 ~4.75:1, brightBlack #586e75 ~2.8:1 — must stay untouched.
    const floor = resolveTerminalMinimumContrastRatio('#002b36', 'dark', '#839496')
    expect(floor).toBeLessThan(DARK_BG_MIN_CONTRAST)
    expect(contrastRatio('#002b36', '#586e75')).toBeGreaterThanOrEqual(floor)
  })

  it('bottoms out at 1 (correction off) for a pathological foreground', () => {
    expect(resolveTerminalMinimumContrastRatio('#fdf6e3', 'light', '#f0ead8')).toBe(1)
  })

  it('falls back to the plain floor for an unparseable foreground', () => {
    expect(resolveTerminalMinimumContrastRatio('#fdf6e3', 'light', 'not-a-color')).toBe(
      LIGHT_BG_MIN_CONTRAST
    )
  })

  it('rates a translucent foreground by the color actually seen over the background', () => {
    // rgba(0,0,0,0.1) over white renders as #e6e6e6 (~1.25:1), not black (21:1).
    expect(resolveTerminalTextContrastRatio('#ffffff', 'rgba(0, 0, 0, 0.1)')).toBe(
      resolveTerminalTextContrastRatio('#ffffff', '#e6e6e6')
    )
    expect(resolveTerminalMinimumContrastRatio('#ffffff', 'light', 'rgba(0, 0, 0, 0.1)')).toBe(1)
    expect(resolveTerminalMinimumContrastRatio('#ffffff', 'light', '#000000')).toBe(
      LIGHT_BG_MIN_CONTRAST
    )
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
