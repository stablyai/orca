import type { CommitMessageModel } from './commit-message-agent-spec'

// Why: `devin models list` defaults to a human table grouped by family; the
// `--format json` variant is the machine-readable surface made for scripts.
export const DEVIN_MODEL_LIST_ARGS = ['models', 'list', '--format', 'json']

/** The outermost JSON value on stdout, or null when none parses. */
function parseJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Why: an update notice can precede the JSON on stdout; the listing itself
    // is the outermost object.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return null
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** Parses `devin models list --format json`: families hold `variants`, and each
 *  variant's `model_uid` is the id `--model` accepts. */
export function parseDevinModelList(stdout: string): CommitMessageModel[] {
  const parsed = parseJsonObject(stdout)
  if (!parsed || typeof parsed !== 'object' || !('families' in parsed)) {
    return []
  }
  const families: unknown = parsed.families
  if (!Array.isArray(families)) {
    return []
  }
  const byId = new Map<string, CommitMessageModel>()
  for (const family of families) {
    if (!family || typeof family !== 'object' || !('variants' in family)) {
      continue
    }
    const familyLabel =
      'family_label' in family && typeof family.family_label === 'string'
        ? family.family_label.trim()
        : ''
    const variants: unknown = family.variants
    if (!Array.isArray(variants)) {
      continue
    }
    for (const variant of variants) {
      if (!variant || typeof variant !== 'object') {
        continue
      }
      const id =
        'model_uid' in variant && typeof variant.model_uid === 'string'
          ? variant.model_uid.trim()
          : ''
      if (!id || byId.has(id)) {
        continue
      }
      const label = 'label' in variant && typeof variant.label === 'string' ? variant.label : id
      const description =
        'description' in variant && typeof variant.description === 'string'
          ? variant.description
          : familyLabel
      const contextWindow =
        'max_context_tokens' in variant && typeof variant.max_context_tokens === 'number'
          ? variant.max_context_tokens
          : null
      byId.set(id, {
        id,
        label: label || id,
        ...(description ? { description } : {}),
        ...(contextWindow !== null && Number.isFinite(contextWindow) && contextWindow > 0
          ? { contextWindowTokens: contextWindow }
          : {})
      })
    }
  }
  return [...byId.values()]
}
