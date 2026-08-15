/**
 * File-icon theme artifact (`icon-theme.json`) contributed by a plugin.
 *
 * Shape mirrors the common editor-ecosystem icon-theme convention: named icon
 * definitions plus filename/extension lookup tables. Parsing lives in `shared`
 * so desktop, `orca serve`, and the CLI accept identical themes (SSH parity).
 *
 * EXPERIMENTAL alongside the rest of pluginApi v1.
 */

export const PLUGIN_ICON_THEME_MAX_DEFINITIONS = 2_000
export const PLUGIN_ICON_THEME_MAX_LOOKUP_ENTRIES = 8_000
/** Per-SVG ceiling; the registry additionally bounds the whole theme. */
export const PLUGIN_ICON_SVG_MAX_BYTES = 64 * 1024
export const PLUGIN_ICON_THEME_MANIFEST_MAX_BYTES = 1024 * 1024
export const PLUGIN_ICON_THEME_TOTAL_MAX_BYTES = 8 * 1024 * 1024

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export type PluginIconThemeArtifact = {
  /** Icon definition id -> plugin-relative SVG path. */
  iconDefinitions: Record<string, string>
  /** Lowercased extension (no leading dot) -> icon definition id. */
  fileExtensions: Record<string, string>
  /** Lowercased full filename -> icon definition id. */
  fileNames: Record<string, string>
  /** Icon definition id used when no lookup matches. */
  defaultIcon: string | null
}

export type PluginIconThemeParseResult =
  | { ok: true; artifact: PluginIconThemeArtifact }
  | { ok: false; error: string }

/** One theme as published to renderers: SVGs already inlined as data URLs. */
export type PluginIconThemeRegistration = {
  /** Qualified across plugins so two plugins may both ship a "material" id. */
  id: string
  pluginKey: string
  themeId: string
  label: string
  /** Icon definition id -> `data:image/svg+xml` URL. */
  icons: Record<string, string>
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  defaultIcon: string | null
}

export function pluginIconThemeId(pluginKey: string, themeId: string): string {
  return `${pluginKey}#${themeId}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 128 &&
    !DANGEROUS_KEYS.has(key) &&
    !Array.from(key).some((character) => character.charCodeAt(0) <= 31)
  )
}

function normalizeExtension(key: string): string {
  return key.replace(/^\.+/, '').toLowerCase()
}

type LookupParse = { ok: true; table: Record<string, string> } | { ok: false; error: string }

function parseLookupTable(
  raw: unknown,
  label: string,
  definitions: Record<string, string>,
  normalizeKey: (key: string) => string,
  budget: { remaining: number }
): LookupParse {
  if (raw === undefined) {
    return { ok: true, table: {} }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: `${label} must be an object` }
  }
  const table: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(raw)) {
    budget.remaining -= 1
    if (budget.remaining < 0) {
      return {
        ok: false,
        error: `icon theme exceeds ${PLUGIN_ICON_THEME_MAX_LOOKUP_ENTRIES} lookup entries`
      }
    }
    if (!isSafeKey(key)) {
      return { ok: false, error: `${label} key ${key || '(empty)'} is not safe` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `${label}.${key} must name an icon definition` }
    }
    if (!Object.hasOwn(definitions, value)) {
      return { ok: false, error: `${label}.${key} references unknown icon definition ${value}` }
    }
    const normalized = normalizeKey(key)
    if (normalized.length === 0) {
      return { ok: false, error: `${label} key ${key} normalizes to an empty key` }
    }
    table[normalized] = value
  }
  return { ok: true, table }
}

export function parsePluginIconThemeArtifact(raw: string): PluginIconThemeParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'icon theme must contain one JSON object' }
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: 'icon theme root must be an object' }
  }

  const rawDefinitions = json.iconDefinitions
  if (!isPlainObject(rawDefinitions)) {
    return { ok: false, error: 'icon theme requires an iconDefinitions object' }
  }
  const iconDefinitions: Record<string, string> = Object.create(null) as Record<string, string>
  let definitionCount = 0
  for (const [key, value] of Object.entries(rawDefinitions)) {
    definitionCount += 1
    if (definitionCount > PLUGIN_ICON_THEME_MAX_DEFINITIONS) {
      return {
        ok: false,
        error: `icon theme exceeds ${PLUGIN_ICON_THEME_MAX_DEFINITIONS} icon definitions`
      }
    }
    if (!isSafeKey(key)) {
      return { ok: false, error: `iconDefinitions key ${key || '(empty)'} is not safe` }
    }
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, error: `iconDefinitions.${key} must be a relative SVG path` }
    }
    iconDefinitions[key] = value
  }

  const budget = { remaining: PLUGIN_ICON_THEME_MAX_LOOKUP_ENTRIES }
  const extensions = parseLookupTable(
    json.fileExtensions,
    'fileExtensions',
    iconDefinitions,
    normalizeExtension,
    budget
  )
  if (!extensions.ok) {
    return extensions
  }
  const names = parseLookupTable(
    json.fileNames,
    'fileNames',
    iconDefinitions,
    (key) => key.toLowerCase(),
    budget
  )
  if (!names.ok) {
    return names
  }

  let defaultIcon: string | null = null
  if (json.default !== undefined) {
    if (typeof json.default !== 'string' || !Object.hasOwn(iconDefinitions, json.default)) {
      return { ok: false, error: 'default must reference a declared icon definition' }
    }
    defaultIcon = json.default
  }

  return {
    ok: true,
    artifact: {
      iconDefinitions,
      fileExtensions: extensions.table,
      fileNames: names.table,
      defaultIcon
    }
  }
}

// Why: icons render in an <img>, which already blocks SVG script and external
// fetches; these rejections are defense in depth so a theme can't smuggle
// active content past a future renderer that inlines the markup instead.
const FORBIDDEN_SVG_PATTERNS: readonly [RegExp, string][] = [
  [/<\s*script/i, 'script element'],
  [/<\s*foreignObject/i, 'foreignObject element'],
  [/<\s*(iframe|object|embed)/i, 'embedded document element'],
  [/\bon[a-z]+\s*=/i, 'inline event handler'],
  [/javascript\s*:/i, 'javascript: URL'],
  [/<!ENTITY/i, 'XML entity declaration']
]

export type PluginIconSvgValidation = { ok: true } | { ok: false; error: string }

export function validatePluginIconSvg(svg: string): PluginIconSvgValidation {
  if (!/<\s*svg[\s>]/i.test(svg)) {
    return { ok: false, error: 'is not an SVG document' }
  }
  for (const [pattern, label] of FORBIDDEN_SVG_PATTERNS) {
    if (pattern.test(svg)) {
      return { ok: false, error: `contains a forbidden ${label}` }
    }
  }
  return { ok: true }
}

// Why: spreading a whole 64 KiB icon into String.fromCharCode can exceed the
// engine argument cap, so the browser/CLI path encodes in chunks.
const BASE64_CHUNK_BYTES = 0x8000

function browserBase64(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }
  return btoa(binary)
}

export function pluginIconSvgDataUrl(svg: string): string {
  // base64 avoids percent-encoding every quote/angle bracket in the payload.
  const base64 =
    typeof Buffer === 'undefined' ? browserBase64(svg) : Buffer.from(svg, 'utf8').toString('base64')
  return `data:image/svg+xml;base64,${base64}`
}
