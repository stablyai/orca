import type { ThemesType } from '@pierre/diffs'

/**
 * `light-plus` / `dark-plus` are the VS Code default themes that Monaco's
 * `vs` / `vs-dark` mirror, so swapping renderers keeps syntax colors stable.
 */
export const PIERRE_DIFF_THEMES: ThemesType = {
  light: 'light-plus',
  dark: 'dark-plus'
}
