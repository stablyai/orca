import type { AppThemePresetId, GlobalSettings } from '../../../shared/global-settings-types'
import { resolveEffectiveThemePreset } from './app-theme-presets'

export type DocumentThemePreference = GlobalSettings['theme']

export const THEME_TRANSITION_DISABLED_CLASS = 'theme-transition-disabled'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

type ThemeClassList = {
  add: (...tokens: string[]) => void
  remove: (...tokens: string[]) => void
  toggle: (token: string, force?: boolean) => boolean
}

type ThemeRoot = {
  classList: ThemeClassList
  dataset?: Record<string, string | undefined>
  setAttribute?: (qualifiedName: string, value: string) => void
  removeAttribute?: (qualifiedName: string) => void
}

type ThemeMediaMatcher = (query: string) => Pick<MediaQueryList, 'matches'>
type ThemeAnimationFrame = (callback: FrameRequestCallback) => number
type ThemeCancelAnimationFrame = (handle: number) => void

type ApplyDocumentThemeOptions = {
  root?: ThemeRoot
  themePreset?: AppThemePresetId
  matchMedia?: ThemeMediaMatcher
  requestAnimationFrame?: ThemeAnimationFrame
  cancelAnimationFrame?: ThemeCancelAnimationFrame
  disableTransitions?: boolean
}

let pendingTransitionDisableFrames: number[] = []

function cancelPendingTransitionDisableFrames(cancelFrame: ThemeCancelAnimationFrame): void {
  for (const frameId of pendingTransitionDisableFrames) {
    cancelFrame(frameId)
  }
  pendingTransitionDisableFrames = []
}

function systemPrefersDark(matchMedia?: ThemeMediaMatcher): boolean {
  if (matchMedia) {
    return matchMedia(DARK_MODE_QUERY).matches
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia(DARK_MODE_QUERY).matches
  }
  return false
}

/**
 * Determines whether dark mode should be applied based on theme setting and system query.
 */
export function resolveDocumentTheme(
  theme: DocumentThemePreference,
  matchMedia?: ThemeMediaMatcher
): boolean {
  if (theme === 'dark') {
    return true
  }
  if (theme === 'light') {
    return false
  }
  return systemPrefersDark(matchMedia)
}

/**
 * Applies the resolved theme mode and theme preset dataset attribute to the document root element.
 */
export function applyDocumentTheme(
  theme: DocumentThemePreference,
  options: ApplyDocumentThemeOptions = {}
): void {
  const root = options.root ?? document.documentElement
  const disableTransitions = options.disableTransitions ?? true
  const shouldUseDarkTheme = resolveDocumentTheme(theme, options.matchMedia)
  const isSystemDark = systemPrefersDark(options.matchMedia)
  const effectivePreset = resolveEffectiveThemePreset(theme, options.themePreset, isSystemDark)

  if (disableTransitions) {
    root.classList.add(THEME_TRANSITION_DISABLED_CLASS)
  }

  root.classList.toggle('dark', shouldUseDarkTheme)
  // Mirror with `light` so consumers can observe the resolved theme
  // symmetrically (Tailwind keys only on `dark`, so this is style-neutral).
  root.classList.toggle('light', !shouldUseDarkTheme)

  if (effectivePreset !== 'default') {
    if (root.dataset) {
      root.dataset.theme = effectivePreset
    } else if (root.setAttribute) {
      root.setAttribute('data-theme', effectivePreset)
    }
  } else {
    if (root.dataset) {
      delete root.dataset.theme
    } else if (root.removeAttribute) {
      root.removeAttribute('data-theme')
    }
  }

  if (!disableTransitions) {
    return
  }

  const requestFrame = options.requestAnimationFrame ?? window.requestAnimationFrame.bind(window)
  const cancelFrame = options.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window)
  cancelPendingTransitionDisableFrames(cancelFrame)

  // Why: two frames lets the root theme class recalculate before restoring
  // normal hover/collapse transitions, preventing staggered color fades.
  const firstFrame = requestFrame(() => {
    pendingTransitionDisableFrames = pendingTransitionDisableFrames.filter(
      (id) => id !== firstFrame
    )
    const secondFrame = requestFrame(() => {
      pendingTransitionDisableFrames = pendingTransitionDisableFrames.filter(
        (id) => id !== secondFrame
      )
      root.classList.remove(THEME_TRANSITION_DISABLED_CLASS)
    })
    pendingTransitionDisableFrames.push(secondFrame)
  })
  pendingTransitionDisableFrames.push(firstFrame)
}
