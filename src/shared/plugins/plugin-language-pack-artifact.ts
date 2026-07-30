export const PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES = 20_000
export const PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH = 16

const DANGEROUS_CATALOG_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
// Why: every plugin-facing security surface lives under this namespace, so
// protecting the whole subtree keeps a new dialog from silently becoming
// plugin-writable the way PluginConsentProvenance did when it was extracted.
const PROTECTED_TRANSLATION_ROOT = 'auto.components.settings.'
const PROTECTED_TRANSLATION_MODULE = /^plugin/i

export type PluginLanguagePackRegistration = {
  id: `plugin:${string}`
  resourceLanguage: `plugin${string}`
  pluginKey: string
  locale: string
  catalog: Record<string, unknown>
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

type CatalogFrame = {
  source: Record<string, unknown>
  target: Record<string, unknown>
  path: string
  depth: number
}

function isCatalogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protectedTranslation(path: string): boolean {
  if (!path.startsWith(PROTECTED_TRANSLATION_ROOT)) {
    return false
  }
  return PROTECTED_TRANSLATION_MODULE.test(path.slice(PROTECTED_TRANSLATION_ROOT.length))
}

function hasUnsafeCatalogKeyCharacter(key: string): boolean {
  return key.includes('.') || Array.from(key).some((character) => character.charCodeAt(0) <= 31)
}

export function parsePluginLanguagePackArtifact(raw: string): PluginLanguagePackParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'language pack must contain one JSON object' }
  }
  if (!isCatalogObject(json)) {
    return { ok: false, error: 'language pack root must be an object' }
  }

  const catalog: Record<string, unknown> = {}
  const stack: CatalogFrame[] = [{ source: json, target: catalog, path: '', depth: 0 }]
  let entries = 0
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.depth > PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH) {
      return { ok: false, error: `catalog exceeds depth ${PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH}` }
    }
    for (const [key, value] of Object.entries(frame.source)) {
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
      if (protectedTranslation(path)) {
        return { ok: false, error: `catalog cannot replace protected security copy at ${path}` }
      }
      if (typeof value === 'string') {
        if (value.length > 8192) {
          return { ok: false, error: `translation at ${path} exceeds 8192 characters` }
        }
        frame.target[key] = value
        continue
      }
      if (!isCatalogObject(value)) {
        return { ok: false, error: `translation at ${path} must be a string or object` }
      }
      const child: Record<string, unknown> = {}
      frame.target[key] = child
      stack.push({ source: value, target: child, path, depth: frame.depth + 1 })
    }
  }
  return { ok: true, catalog, entries }
}
