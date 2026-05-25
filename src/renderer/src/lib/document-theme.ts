import type { GlobalSettings } from '../../../shared/types'

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
}

type ThemeMediaMatcher = (query: string) => Pick<MediaQueryList, 'matches'>
type ThemeAnimationFrame = (callback: FrameRequestCallback) => number

type ApplyDocumentThemeOptions = {
  root?: ThemeRoot
  matchMedia?: ThemeMediaMatcher
  requestAnimationFrame?: ThemeAnimationFrame
  disableTransitions?: boolean
  /**
   * Whether the host is macOS. Defaults to a userAgent sniff in the browser.
   * Passing this explicitly is required in tests because jsdom's userAgent
   * does not include "Mac" by default.
   */
  isDarwin?: boolean
}

function systemPrefersDark(
  matchMedia: ThemeMediaMatcher = window.matchMedia.bind(window)
): boolean {
  return matchMedia(DARK_MODE_QUERY).matches
}

function detectIsDarwin(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return navigator.userAgent.includes('Mac')
}

export function resolveDocumentTheme(
  theme: DocumentThemePreference,
  matchMedia?: ThemeMediaMatcher
): boolean {
  if (theme === 'dark' || theme === 'glass-dark') {
    return true
  }
  if (theme === 'light' || theme === 'glass-light') {
    return false
  }
  return systemPrefersDark(matchMedia)
}

export function applyDocumentTheme(
  theme: DocumentThemePreference,
  options: ApplyDocumentThemeOptions = {}
): void {
  const root = options.root ?? document.documentElement
  const disableTransitions = options.disableTransitions ?? true
  const isDarwin = options.isDarwin ?? detectIsDarwin()
  const shouldUseDarkTheme = resolveDocumentTheme(theme, options.matchMedia)

  // Why: glass themes require macOS vibrancy at the window level. On other
  // platforms we silently fall back to the matching non-glass variant rather
  // than rendering broken translucent surfaces. The settings file keeps the
  // glass value so it reactivates if the same profile is opened on a Mac.
  const effectiveTheme: DocumentThemePreference =
    !isDarwin && theme.startsWith('glass') ? (theme === 'glass-dark' ? 'dark' : 'light') : theme

  if (disableTransitions) {
    root.classList.add(THEME_TRANSITION_DISABLED_CLASS)
  }

  root.classList.toggle('dark', shouldUseDarkTheme)
  // Mirror with `light` so consumers can observe the resolved theme
  // symmetrically (Tailwind keys only on `dark`, so this is style-neutral).
  root.classList.toggle('light', !shouldUseDarkTheme)
  root.classList.toggle('glass-light', effectiveTheme === 'glass-light')
  root.classList.toggle('glass-dark', effectiveTheme === 'glass-dark')

  if (!disableTransitions) {
    return
  }

  const requestFrame = options.requestAnimationFrame ?? window.requestAnimationFrame.bind(window)

  // Why: two frames lets the root theme class recalculate before restoring
  // normal hover/collapse transitions, preventing staggered color fades.
  requestFrame(() => {
    requestFrame(() => {
      root.classList.remove(THEME_TRANSITION_DISABLED_CLASS)
    })
  })
}
