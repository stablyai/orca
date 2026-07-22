import { isTerminalBackgroundLight } from '@/lib/terminal-title-contrast'

// xterm minimumContrastRatio tuning (#7934). Light backgrounds keep WCAG-AA correction so invisible
// white/bright-white ANSI body text stays readable; dark backgrounds disable it (ratio 1) because
// correction over-brightens vibrant ANSI colors.
export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 1

// Why gate by background luminance, not app mode (#7934): either theme slot can hold either kind of
// theme (match-dark-mode, or a light theme in the dark slot), so follow the composed background.
export function resolveTerminalMinimumContrastRatio(
  background: string | undefined,
  appSurface: 'dark' | 'light'
): number {
  return isTerminalBackgroundLight(background, { appSurface })
    ? LIGHT_BG_MIN_CONTRAST
    : DARK_BG_MIN_CONTRAST
}
