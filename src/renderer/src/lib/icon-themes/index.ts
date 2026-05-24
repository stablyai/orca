import { defaultIconTheme } from './default'
import { resolveIcon } from './resolve'
import { mergeIconThemeCatalogs } from './shared'
import type { IconNode, IconTheme } from './types'
import {
  parseVscodeIconTheme,
  removeInjectedFontFaces,
  type SvgIconRegistry,
  type VscodeIconThemeShape
} from './vscode-icon-theme'

export type {
  IconNode,
  IconTheme,
  IconThemeFileRule,
  IconThemeFolderRule,
  FolderIconState
} from './types'

export { resolveIcon } from './resolve'
export { parseVscodeIconTheme } from './vscode-icon-theme'
export type { VscodeIconThemeShape, SvgIconRegistry, ParseVscodeOptions } from './vscode-icon-theme'

const BUILTIN_THEMES: IconTheme[] = [defaultIconTheme]

export const ICON_THEME_CATALOG = mergeIconThemeCatalogs(BUILTIN_THEMES)

// Why: user-imported themes are hydrated at runtime from the main process and
// live in a separate mutable map so they can be added/removed without
// reaching into the builtin catalog. Lookups consult both maps.
const USER_ICON_THEME_CATALOG: Record<string, IconTheme> = {}

// Why: subscribers (Settings dropdown, FileExplorer rows) need to re-render
// when the user catalog mutates. We expose a tiny pub/sub so React components
// can either useSyncExternalStore or just bump a useState.
type Listener = () => void
const listeners = new Set<Listener>()
function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {}
  })
}

export function subscribeUserIconThemes(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const DEFAULT_ICON_THEME_ID = 'default'

export function getIconTheme(id: string): IconTheme | undefined {
  return USER_ICON_THEME_CATALOG[id] ?? ICON_THEME_CATALOG[id]
}

export function getIconThemes(): IconTheme[] {
  return [...Object.values(ICON_THEME_CATALOG), ...Object.values(USER_ICON_THEME_CATALOG)]
}

/**
 * Register (or replace) a user-imported icon theme. The JSON shape is the
 * resolved VS Code icon theme (with `iconPath` values rewritten to inline
 * `data:` URIs at import time by the main process), so the SVG registry
 * passes those URIs straight through.
 */
export function registerUserIconTheme(args: {
  id: string
  name: string
  shape: VscodeIconThemeShape
}): IconTheme | null {
  const registry: SvgIconRegistry = {
    resolveIconUrl: (iconPath) => iconPath ?? null
  }
  const theme = parseVscodeIconTheme(args.shape, registry, {
    id: args.id,
    name: args.name,
    description: 'User-imported VS Code icon theme.',
    variant: 'default'
  })
  if (!theme) {
    return null
  }
  USER_ICON_THEME_CATALOG[args.id] = theme
  notify()
  return theme
}

export function unregisterUserIconTheme(id: string): void {
  if (id in USER_ICON_THEME_CATALOG) {
    delete USER_ICON_THEME_CATALOG[id]
    removeInjectedFontFaces(id)
    notify()
  }
}

type StoredUserIconTheme = {
  id: string
  sourceFolderName: string
  json: VscodeIconThemeShape & { name?: string }
}

let hydratePromise: Promise<void> | null = null

/**
 * Fetch the persisted user icon themes from the main process and register
 * each one. Idempotent: subsequent calls return the same in-flight promise so
 * concurrent callers don't double-fetch.
 */
export function hydrateUserIconThemes(): Promise<void> {
  if (hydratePromise) {
    return hydratePromise
  }
  const api = (
    globalThis as { api?: { iconThemes?: { list: () => Promise<StoredUserIconTheme[]> } } }
  ).api
  if (!api?.iconThemes) {
    hydratePromise = Promise.resolve()
    return hydratePromise
  }
  hydratePromise = (async () => {
    try {
      const list = await api.iconThemes!.list()
      for (const entry of list) {
        const name = (entry.json?.name as string | undefined) ?? entry.sourceFolderName
        registerUserIconTheme({ id: entry.id, name, shape: entry.json })
      }
    } catch {
      // Swallow — startup must not crash on a corrupt user theme file.
    }
  })()
  return hydratePromise
}

// Side-effect: kick off hydration as soon as the module is imported. Safe
// because preload runs before the renderer JS executes, so `window.api` is
// already present on import.
void hydrateUserIconThemes()

/**
 * Resolve an icon using `id`, falling back to the `default` theme if `id`
 * does not match a known catalog entry. Centralizes the "unknown theme id"
 * recovery rule so callers (hooks, previews) don't have to repeat it.
 */
export function resolveIconWithFallback(
  id: string,
  filePath: string,
  isDirectory: boolean,
  isOpen: boolean
): IconNode {
  const theme = USER_ICON_THEME_CATALOG[id] ?? ICON_THEME_CATALOG[id] ?? defaultIconTheme
  return resolveIcon(theme, filePath, isDirectory, isOpen)
}
