import { parse } from 'yaml'

export type FrontMatterField = {
  key: string
  /** Display string; arrays are comma-joined, nested maps flattened to `key: value` pairs. */
  value: string
}

/**
 * Parses a raw front-matter block into key/value rows for tabular display.
 * Returns null when the block isn't a structured YAML map — TOML (`+++`), a
 * bare scalar/list, an empty map, or a parse error — so callers can fall back
 * to rendering the raw text.
 */
export function parseFrontMatterFields(raw: string): FrontMatterField[] | null {
  // The yaml parser doesn't handle TOML front matter.
  if (raw.trimStart().startsWith('+++')) {
    return null
  }

  const inner = raw
    .replace(/^(?:---|\+\+\+)\r?\n/, '')
    .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
    .trim()

  let data: unknown
  try {
    data = parse(inner)
  } catch {
    return null
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null
  }

  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length === 0) {
    return null
  }

  return entries.map(([key, value]) => ({ key, value: formatValue(value) }))
}

// Strip the opening/closing delimiters to expose only the raw YAML/TOML content.
export function stripFrontMatterDelimiters(raw: string): string {
  return raw
    .replace(/^(?:---|\+\+\+)\r?\n/, '')
    .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
    .trim()
}

function formatValue(value: unknown): string {
  if (value == null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map(formatValue).join(', ')
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // Why: fall back to String() for objects with no enumerable entries (e.g. an
    // exotic tagged value) so they don't silently render as an empty cell.
    if (entries.length === 0) {
      return String(value)
    }
    return entries.map(([key, nested]) => `${key}: ${formatValue(nested)}`).join(', ')
  }
  return String(value)
}
