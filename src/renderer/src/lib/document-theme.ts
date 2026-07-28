import type { GlobalSettings } from '../../../shared/types'
import type { PluginThemeRegistration } from '../../../shared/plugins/plugin-theme-artifact'

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

type PluginThemeRoot = ThemeRoot & {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
  dataset?: DOMStringMap
}

type ThemeMediaMatcher = (query: string) => Pick<MediaQueryList, 'matches'>
type ThemeAnimationFrame = (callback: FrameRequestCallback) => number
type ThemeCancelAnimationFrame = (handle: number) => void

type ApplyDocumentThemeOptions = {
  root?: ThemeRoot
  matchMedia?: ThemeMediaMatcher
  requestAnimationFrame?: ThemeAnimationFrame
  cancelAnimationFrame?: ThemeCancelAnimationFrame
  disableTransitions?: boolean
}

let pendingTransitionDisableFrames: number[] = []
const appliedPluginTokens = new WeakMap<object, Set<string>>()

function cancelPendingTransitionDisableFrames(cancelFrame: ThemeCancelAnimationFrame): void {
  for (const frameId of pendingTransitionDisableFrames) {
    cancelFrame(frameId)
  }
  pendingTransitionDisableFrames = []
}

function systemPrefersDark(
  matchMedia: ThemeMediaMatcher = window.matchMedia.bind(window)
): boolean {
  return matchMedia(DARK_MODE_QUERY).matches
}

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

export function applyDocumentTheme(
  theme: DocumentThemePreference,
  options: ApplyDocumentThemeOptions = {}
): void {
  const root = options.root ?? document.documentElement
  const disableTransitions = options.disableTransitions ?? true
  const shouldUseDarkTheme = resolveDocumentTheme(theme, options.matchMedia)

  if (disableTransitions) {
    root.classList.add(THEME_TRANSITION_DISABLED_CLASS)
  }

  root.classList.toggle('dark', shouldUseDarkTheme)
  // Mirror with `light` so consumers can observe the resolved theme
  // symmetrically (Tailwind keys only on `dark`, so this is style-neutral).
  root.classList.toggle('light', !shouldUseDarkTheme)

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

export function applyPluginAppTheme(
  theme: PluginThemeRegistration | null,
  root: PluginThemeRoot = document.documentElement
): void {
  const previous = appliedPluginTokens.get(root) ?? new Set<string>()
  const next = new Set(Object.keys(theme?.tokens ?? {}))
  for (const token of previous) {
    if (!next.has(token)) {
      root.style.removeProperty(token)
    }
  }
  for (const [token, value] of Object.entries(theme?.tokens ?? {})) {
    root.style.setProperty(token, value)
  }
  appliedPluginTokens.set(root, next)
  if (root.dataset) {
    if (theme) {
      root.dataset.orcaPluginTheme = theme.id
    } else {
      delete root.dataset.orcaPluginTheme
    }
  }
}
