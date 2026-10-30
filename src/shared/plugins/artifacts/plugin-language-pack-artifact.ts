import type { PluginArtifactStrictness } from './plugin-theme-artifact'
import {
  translatablePluginChrome,
  translatablePluginChromeContainer
} from '../languages/plugin-translatable-chrome'

// Why headroom: a complete pack already carries ~18k entries and the English catalog keeps growing.
export const PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES = 50_000
export const PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH = 16

const DANGEROUS_CATALOG_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
// Protect plugin security copy across the whole namespace so extracted/new dialogs cannot become writable.
// Exact nonsecurity chrome exemptions live in plugin-translatable-chrome.ts.
const PROTECTED_TRANSLATION_ROOT = 'auto.components.settings.'
const PROTECTED_TRANSLATION_MODULE = /^plugin/i
// Trust copy outside that root, protected by whole component: a pack must not relabel the
// Official badge, the catalog suggestion banner, agent Allow/Deny, a run-code trust prompt,
// the certificate warning, or a site's Allow/Block permission prompt.
const PROTECTED_TRANSLATION_COMPONENTS = [
  'auto.components.pluginCatalog.PluginListRow.official',
  'auto.components.editor.PluginFileTypeSuggestion',
  'components.native-chat.approval',
  'auto.components.sidebar.OrcaYamlTrustDialog',
  'auto.components.editor.IpynbViewer',
  'browser.loadFailure',
  'auto.components.browserPane.sitePermission',
  'settings.browser.sitePermissions'
]

export type PluginLanguagePackRegistration = {
  id: `plugin:${string}`
  resourceLanguage: string
  pluginKey: string
  locale: string
  displayName?: string
  catalog: Record<string, unknown>
  /** Whole percent of translatable English strings this pack translates. */
  coverage: number
}

export function isPluginLanguagePackRegistration(
  value: unknown
): value is PluginLanguagePackRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const pack = value as Record<string, unknown>
  return (
    typeof pack.id === 'string' &&
    pack.id.startsWith('plugin:') &&
    typeof pack.resourceLanguage === 'string' &&
    pack.resourceLanguage === pluginLanguageResourceId(pack.id as `plugin:${string}`) &&
    typeof pack.pluginKey === 'string' &&
    typeof pack.locale === 'string' &&
    (pack.displayName === undefined || typeof pack.displayName === 'string') &&
    typeof pack.coverage === 'number' &&
    pack.coverage >= 0 &&
    pack.coverage <= 100 &&
    checkPluginLanguagePackCatalog(pack.catalog).ok
  )
}

// Internal i18next ID only; settings and IPC keep the qualified `plugin:` ID.
export function pluginLanguageResourceId(id: `plugin:${string}`): string {
  // Fixed-width UTF-8 hex keeps IDs collision-free; private-use subtags allow at most 8 chars.
  const encoded = Array.from(new TextEncoder().encode(id.slice('plugin:'.length)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  const subtags = encoded.match(/.{1,8}/g) ?? []
  // The real base locale lets Intl and i18next pick the pack's plural rules natively.
  return `${pluginPackBaseLocale(id.slice(id.lastIndexOf('/') + 1))}-x-orcapk-${subtags.join('-')}`
}

function pluginPackBaseLocale(locale: string): string {
  try {
    const supported = Intl.PluralRules.supportedLocalesOf(locale)[0]
    // Unsupported tags would get the runtime's plural rules; use English like other unknown locales.
    return supported ? new Intl.Locale(supported).baseName : 'en'
  } catch {
    return 'en'
  }
}

export type PluginLanguagePackParseResult =
  | { ok: true; catalog: Record<string, unknown>; entries: number }
  | { ok: false; error: string }

export type PluginLanguagePackValidationResult =
  | { ok: true; entries: number }
  | { ok: false; error: string }

type PluginLanguagePackWalkResult =
  | { ok: true; catalog: Record<string, unknown> | null; entries: number }
  | { ok: false; error: string }

type CatalogFrame = {
  source: Record<string, unknown>
  target: Record<string, unknown> | null
  path: string
  depth: number
}

export function isCatalogObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/** Security copy that no language pack may replace. */
export function isProtectedPluginTranslationPath(path: string): boolean {
  if (
    PROTECTED_TRANSLATION_COMPONENTS.some(
      (component) => path === component || path.startsWith(`${component}.`)
    )
  ) {
    return true
  }
  if (!path.startsWith(PROTECTED_TRANSLATION_ROOT)) {
    return false
  }
  if (translatablePluginChrome(path)) {
    return false
  }
  return PROTECTED_TRANSLATION_MODULE.test(path.slice(PROTECTED_TRANSLATION_ROOT.length))
}

function hasUnsafeCatalogKeyCharacter(key: string): boolean {
  if (key.includes('.')) {
    return true
  }
  for (let index = 0; index < key.length; index += 1) {
    if (key.charCodeAt(index) <= 31) {
      return true
    }
  }
  return false
}

// Why tolerant at load: Orca protects more copy over time, so a pack published before a path
// was protected must still load, with that path left in English; validate:plugin is strict.
export function parsePluginLanguagePackArtifact(
  raw: string,
  strictness: PluginArtifactStrictness = 'strict'
): PluginLanguagePackParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'language pack must contain one JSON object' }
  }
  return validatePluginLanguagePackCatalog(json, strictness)
}

export function validatePluginLanguagePackCatalog(
  source: unknown,
  strictness: PluginArtifactStrictness = 'strict'
): PluginLanguagePackParseResult {
  const result = walkPluginLanguagePackCatalog(source, true, strictness)
  if (!result.ok) {
    return result
  }
  return { ok: true, catalog: result.catalog!, entries: result.entries }
}

export function checkPluginLanguagePackCatalog(
  source: unknown
): PluginLanguagePackValidationResult {
  const result = walkPluginLanguagePackCatalog(source, false, 'strict')
  return result.ok ? { ok: true, entries: result.entries } : result
}

function walkPluginLanguagePackCatalog(
  source: unknown,
  copyCatalog: boolean,
  strictness: PluginArtifactStrictness
): PluginLanguagePackWalkResult {
  if (!isCatalogObject(source)) {
    return { ok: false, error: 'language pack root must be an object' }
  }

  const catalog: Record<string, unknown> | null = copyCatalog ? {} : null
  const stack: CatalogFrame[] = [{ source, target: catalog, path: '', depth: 0 }]
  const seen = new WeakSet<object>([source])
  let entries = 0
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.depth > PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH) {
      return { ok: false, error: `catalog exceeds depth ${PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH}` }
    }
    for (const key of Object.keys(frame.source)) {
      const value = frame.source[key]
      entries += 1
      if (entries > PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES) {
        return {
          ok: false,
          error: `catalog exceeds ${PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES} entries`
        }
      }
      if (
        key.length === 0 ||
        key.length > 128 ||
        DANGEROUS_CATALOG_KEYS.has(key) ||
        hasUnsafeCatalogKeyCharacter(key)
      ) {
        return { ok: false, error: `catalog key ${key || '(empty)'} is not safe` }
      }
      const path = frame.path ? `${frame.path}.${key}` : key
      // Walk protected containers only to reach exempt chrome; still check every leaf’s full path.
      if (
        isProtectedPluginTranslationPath(path) &&
        !(isCatalogObject(value) && translatablePluginChromeContainer(path))
      ) {
        if (strictness === 'tolerant') {
          continue
        }
        return { ok: false, error: `catalog cannot replace protected security copy at ${path}` }
      }
      if (typeof value === 'string') {
        if (value.length > 8192) {
          return { ok: false, error: `translation at ${path} exceeds 8192 characters` }
        }
        if (frame.target) {
          frame.target[key] = value
        }
        continue
      }
      if (!isCatalogObject(value)) {
        return { ok: false, error: `translation at ${path} must be a string or object` }
      }
      if (seen.has(value)) {
        return { ok: false, error: `catalog contains a repeated or cyclic object at ${path}` }
      }
      seen.add(value)
      const child: Record<string, unknown> | null = frame.target ? {} : null
      if (frame.target && child) {
        frame.target[key] = child
      }
      stack.push({ source: value, target: child, path, depth: frame.depth + 1 })
    }
  }
  return { ok: true, catalog, entries }
}
