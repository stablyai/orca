import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  PLUGIN_APP_THEME_TOKENS,
  type PluginThemeRegistration
} from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import { browserColorProbe, safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'

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
type ThemeCancelAnimationFrame = (handle: number) => void

type ApplyDocumentThemeOptions = {
  root?: ThemeRoot
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
  // Mirror light for symmetric observation; Tailwind still styles only dark.
  root.classList.toggle('light', !shouldUseDarkTheme)

  if (!disableTransitions) {
    return
  }

  const requestFrame = options.requestAnimationFrame ?? window.requestAnimationFrame.bind(window)
  const cancelFrame = options.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window)
  cancelPendingTransitionDisableFrames(cancelFrame)

  // Wait two frames for root theme recalculation before restoring transitions to avoid staggered fades.
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

type PluginThemeRoot = {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
}

export type CachedPluginAppTheme = {
  id: string
  revision: string
  base: 'light' | 'dark'
  tokens: Record<string, string>
}

type PluginThemePaintOptions = {
  root?: PluginThemeRoot
  probe?: ColorProbe
  /** Built-in token values for the current light/dark mode; read from the document by default. */
  builtIns?: () => Record<string, string>
}

const PUBLIC_TOKENS = new Set<string>(PLUGIN_APP_THEME_TOKENS)
const appliedPluginTokens = new WeakMap<object, readonly string[]>()
// Why: plugin themes load after discovery; repainting from this cache before first paint
// avoids flashing the built-in theme on every launch.
const PLUGIN_THEME_CACHE_KEY = 'orca.pluginAppTheme.lastApplied'

function setPluginTokens(root: PluginThemeRoot, tokens: Record<string, string>): void {
  for (const token of appliedPluginTokens.get(root) ?? []) {
    if (!tokens[token]) {
      root.style.removeProperty(token)
    }
  }
  for (const [token, value] of Object.entries(tokens)) {
    root.style.setProperty(token, value)
  }
  appliedPluginTokens.set(root, Object.keys(tokens))
}

function documentBuiltIns(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(
    PLUGIN_APP_THEME_TOKENS.map((token) => [token, style.getPropertyValue(token).trim()])
  )
}

// Why: menus and dialogs paint a fixed glass tint, which would ignore the theme's --popover
// (a true-black theme got grey dialogs).
const FLOATING_SURFACE_TOKENS = ['--floating-surface', '--dialog-surface'] as const

function withFloatingSurfaces(tokens: Record<string, string>): Record<string, string> {
  const popover = tokens['--popover']
  return popover
    ? { ...tokens, ...Object.fromEntries(FLOATING_SURFACE_TOKENS.map((token) => [token, popover])) }
    : tokens
}

/** Paints tokens that stay readable over this mode's built-ins; returns what was painted. */
function paintPluginTokens(
  tokens: Record<string, string>,
  options: PluginThemePaintOptions
): Record<string, string> {
  const root = options.root ?? document.documentElement
  // Why clear first: built-ins must be read without the previous theme's overrides.
  setPluginTokens(root, {})
  const safe = safePluginThemeTokens(
    tokens,
    (options.builtIns ?? documentBuiltIns)(),
    options.probe ?? browserColorProbe
  )
  setPluginTokens(root, withFloatingSurfaces(safe))
  return safe
}

function writeCache(storage: Storage | null, cached: CachedPluginAppTheme | null): void {
  try {
    if (cached) {
      storage?.setItem(PLUGIN_THEME_CACHE_KEY, JSON.stringify(cached))
    } else {
      storage?.removeItem(PLUGIN_THEME_CACHE_KEY)
    }
  } catch {
    // Storage can be full or unavailable; the cache only shortens startup flashes.
  }
}

/** Overlays a plugin theme's safe tokens; tokens it no longer sets fall back to main.css. Call
 *  after the document's light/dark mode matches the theme's base. */
export function applyPluginAppTheme(
  theme: PluginThemeRegistration | null,
  options: PluginThemePaintOptions & { storage?: Storage | null } = {}
): void {
  const storage = options.storage === undefined ? globalThis.localStorage : options.storage
  if (!theme) {
    setPluginTokens(options.root ?? document.documentElement, {})
    writeCache(storage, null)
    return
  }
  const tokens = paintPluginTokens(theme.tokens, options)
  writeCache(storage, { id: theme.id, revision: theme.revision, base: theme.base, tokens })
}

/** The last applied plugin theme, for painting before settings and plugins load. */
export function readCachedPluginAppTheme(
  storage: Storage | null = globalThis.localStorage ?? null
): CachedPluginAppTheme | null {
  try {
    const cached: unknown = JSON.parse(storage?.getItem(PLUGIN_THEME_CACHE_KEY) ?? 'null')
    if (
      typeof cached !== 'object' ||
      cached === null ||
      !('id' in cached) ||
      typeof cached.id !== 'string' ||
      !('revision' in cached) ||
      typeof cached.revision !== 'string' ||
      !('base' in cached) ||
      (cached.base !== 'light' && cached.base !== 'dark') ||
      !('tokens' in cached) ||
      typeof cached.tokens !== 'object' ||
      cached.tokens === null
    ) {
      return null
    }
    const tokens = Object.fromEntries(
      Object.entries(cached.tokens).filter(
        (entry): entry is [string, string] =>
          PUBLIC_TOKENS.has(entry[0]) && typeof entry[1] === 'string'
      )
    )
    return { id: cached.id, revision: cached.revision, base: cached.base, tokens }
  } catch {
    return null
  }
}

/** Repaints a cached theme at startup, re-checked against this mode's built-ins. */
export function applyCachedPluginAppTheme(
  cached: CachedPluginAppTheme,
  options: PluginThemePaintOptions = {}
): void {
  paintPluginTokens(cached.tokens, options)
}
