import {
  isTerminalBackgroundLight,
  resolveTerminalTextContrastRatio
} from '@/lib/terminal-title-contrast'

// xterm minimumContrastRatio tuning (#7934, #9599, #10104). Light backgrounds keep WCAG-AA correction so
// invisible white/bright-white ANSI body text stays readable. Dark backgrounds use a mild floor of 3
// (WCAG-AA large-text): high enough to rescue near-background body text — e.g. Antigravity's #262b30
// on #1e242a (~1.1:1) — while staying far milder than the light-background 4.5 that badly
// over-brightened vibrant colors (#7934). On most dark themes saturated ANSI colors already clear 3:1
// and are untouched; a few (e.g. Homebrew red/blue on pure black, Gruvbox Dark red) sit below 3:1 and
// get mildly lifted — accepted because those were already near-illegible, so the nudge helps rather
// than harms (see the builtin-catalog exceptions pinned in terminal-contrast-correction.test.ts).
export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 3
// xterm lifts every below-floor color to the floor, so a floor near the theme's own foreground contrast
// collapses dimmed palette text (ANSI 8: zsh-autosuggestions/fish ghost text, prompt hints) into the
// body-text gray — Solarized Light's brightBlack #93a1a1 became #5f6868 beside fg #586e75. Keep the
// floor at half the foreground contrast: that reproduces the ~20 L* step theme authors give their
// dim slot (Solarized Light: fg 5:1, brightBlack 2.5:1). Only low-contrast foregrounds (<9:1 on
// light, <6:1 on dark) ever pull the floor down; a floor of 1 disables correction entirely.
export const DIM_TEXT_CONTRAST_HEADROOM = 2

/**
 * xterm `minimumContrastRatio` for a composed theme: the luminance-gated floor, capped below the
 * theme's own foreground contrast so dim palette slots survive (see `DIM_TEXT_CONTRAST_HEADROOM`).
 * Why gate by background luminance, not app mode (#7934): either theme slot can hold either kind of
 * theme (match-dark-mode, or a light theme in the dark slot), so follow the composed background.
 */
export function resolveTerminalMinimumContrastRatio(
  background: string | undefined,
  appSurface: 'dark' | 'light',
  foreground?: string
): number {
  const floor = isTerminalBackgroundLight(background, { appSurface })
    ? LIGHT_BG_MIN_CONTRAST
    : DARK_BG_MIN_CONTRAST
  const foregroundContrast = resolveTerminalTextContrastRatio(background, foreground, {
    appSurface
  })
  if (foregroundContrast === null) {
    return floor
  }
  return Math.max(1, Math.min(floor, foregroundContrast / DIM_TEXT_CONTRAST_HEADROOM))
}
