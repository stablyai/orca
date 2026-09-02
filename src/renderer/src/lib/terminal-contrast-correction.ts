import { isTerminalBackgroundLight } from '@/lib/terminal-title-contrast'

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

// xterm treats 1 as "never correct"; 21 is the largest ratio that exists (black on white).
export const MIN_CONTRAST_RATIO = 1
export const MAX_CONTRAST_RATIO = 21

// Why gate by background luminance, not app mode (#7934): either theme slot can hold either kind of
// theme (match-dark-mode, or a light theme in the dark slot), so follow the composed background.
// Why an override (#10754): the correction rewrites foregrounds a TUI chose deliberately. Powerline
// statuslines draw the seam between two segments in the neighbouring background color (~1.2:1 by
// design) and dim their secondary text below 3:1, so the floor turns invisible seams into bright
// lines. Setting 1 opts out per user, matching VS Code's terminal.integrated.minimumContrastRatio.
export function resolveTerminalMinimumContrastRatio(
  background: string | undefined,
  appSurface: 'dark' | 'light',
  override?: number
): number {
  if (override !== undefined && Number.isFinite(override)) {
    return Math.min(Math.max(override, MIN_CONTRAST_RATIO), MAX_CONTRAST_RATIO)
  }
  return isTerminalBackgroundLight(background, { appSurface })
    ? LIGHT_BG_MIN_CONTRAST
    : DARK_BG_MIN_CONTRAST
}
