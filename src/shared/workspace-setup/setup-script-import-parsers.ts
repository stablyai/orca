import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { parseDocument } from 'yaml'
import { MAX_ORCA_YAML_ALIAS_COUNT } from '../orca-yaml-file-limit'
import { isOrcaYamlConversionWithinLimit } from '../orca-yaml-merge-expansion'

// Data-only parsers: imports never evaluate repo content, they only read values out of it.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseJsonObject(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    return asRecord(JSON.parse(content))
  } catch {
    return null
  }
}

/** JSON with comments and trailing commas, as devcontainer.json and environment.json allow. */
export function parseJsoncObject(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    const errors: ParseError[] = []
    // Editors on Windows often save a BOM, which the parser otherwise reports as an error.
    // A charCode check, not a regex literal: bundlers emit that as a raw BOM, which the orcad bundle rejects.
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
    const value: unknown = parseJsonc(text, errors, {
      allowTrailingComma: true,
      disallowComments: false
    })
    return errors.length === 0 ? asRecord(value) : null
  } catch {
    // The parser recurses, so pathological nesting can overflow the stack.
    return null
  }
}

export function parseTomlObject(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    return asRecord(parseToml(content, { maxDepth: 32, unsafeKeyBehaviour: 'drop' }))
  } catch {
    return null
  }
}

export function parseYamlObject(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      merge: true,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    // Alias and merge expansion are bounded so a hostile workflow file cannot blow up conversion.
    if (document.errors.length > 0 || !isOrcaYamlConversionWithinLimit(document)) {
      return null
    }
    return asRecord(document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT }))
  } catch {
    return null
  }
}

/** Fields that carry a value, so empty placeholders like `"startup": []` are not reported as skipped. */
export function collectPresentFields(
  source: Record<string, unknown>,
  fieldNames: readonly string[],
  prefix = ''
): string[] {
  return fieldNames.filter((field) => hasValue(source[field])).map((f) => `${prefix}${f}`)
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    return false
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  const record = asRecord(value)
  return record ? Object.keys(record).length > 0 : true
}
