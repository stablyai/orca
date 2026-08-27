import type { DarkAppearanceVariant } from './ui-chrome-types'

/** Pre-paint window fills. Must track `--background` in `main.css` per theme/variant. */
export const DARK_CHROME_BACKGROUND = '#0a0a0a'
export const PURE_BLACK_CHROME_BACKGROUND = '#000000'
export const LIGHT_CHROME_BACKGROUND = '#ffffff'

/** Profiles saved before the variant existed persist `undefined`; they stay on the gray dark theme. */
export function resolveDarkAppearanceVariant(
  variant: DarkAppearanceVariant | null | undefined
): DarkAppearanceVariant {
  return variant === 'pure-black' ? 'pure-black' : 'default'
}

export function isPureBlackVariant(variant: DarkAppearanceVariant | null | undefined): boolean {
  return resolveDarkAppearanceVariant(variant) === 'pure-black'
}

/** Window `backgroundColor` shown before the renderer paints, so launch does not flash gray. */
export function resolveChromeBackgroundColor(args: {
  dark: boolean
  variant?: DarkAppearanceVariant | null
}): string {
  if (!args.dark) {
    return LIGHT_CHROME_BACKGROUND
  }
  return isPureBlackVariant(args.variant) ? PURE_BLACK_CHROME_BACKGROUND : DARK_CHROME_BACKGROUND
}
