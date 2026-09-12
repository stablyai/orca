import {
  translatablePluginChrome,
  translatablePluginChromeContainer
} from './plugin-translatable-chrome'

export const PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES = 20_000
export const PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH = 16

const DANGEROUS_CATALOG_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
// Why: every plugin-facing security surface lives under this namespace, so
// protecting the whole subtree keeps a new dialog from silently becoming
// plugin-writable the way PluginConsentProvenance did when it was extracted.
// The subtree also holds copy with no security meaning; those exact paths are
// listed in plugin-translatable-chrome.ts and stay translatable.
const PROTECTED_TRANSLATION_ROOT = 'auto.components.settings.'
const PROTECTED_TRANSLATION_MODULE = /^plugin/i

export type PluginLanguagePackRegistration = {
  id: `plugin:${string}`
  resourceLanguage: `plugin${string}`
  pluginKey: string
  locale: string
  catalog: Record<string, unknown>
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
    validatePluginLanguagePackCatalogShape(pack.catalog).ok
  )
}

export function pluginLanguageResourceId(id: `plugin:${string}`): `plugin${string}` {
  let encoded = ''
  for (let index = 0; index < id.length; index += 1) {
    encoded += id.charCodeAt(index).toString(16).padStart(4, '0')
  }
  // Why: i18next parses punctuation in language tags during resource lookup;
  // fixed-width UTF-16 hex preserves a collision-free qualified-ID mapping.
  return `plugin${encoded}`
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

function isCatalogObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function protectedTranslation(path: string): boolean {
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

export function parsePluginLanguagePackArtifact(raw: string): PluginLanguagePackParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'language pack must contain one JSON object' }
  }
  return validatePluginLanguagePackCatalog(json)
}

export function validatePluginLanguagePackCatalog(source: unknown): PluginLanguagePackParseResult {
  const result = walkPluginLanguagePackCatalog(source, true)
  if (!result.ok) {
    return result
  }
  return { ok: true, catalog: result.catalog!, entries: result.entries }
}

export function validatePluginLanguagePackCatalogShape(
  source: unknown
): PluginLanguagePackValidationResult {
  const result = walkPluginLanguagePackCatalog(source, false)
  return result.ok ? { ok: true, entries: result.entries } : result
}

function walkPluginLanguagePackCatalog(
  source: unknown,
  copyCatalog: boolean
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
      // A protected container stays walkable only when exempt chrome sits below
      // it; every leaf inside is still matched against its own full path.
      if (
        protectedTranslation(path) &&
        !(isCatalogObject(value) && translatablePluginChromeContainer(path))
      ) {
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
