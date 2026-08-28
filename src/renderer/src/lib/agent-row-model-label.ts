// Why: sidebar rows previously showed a folded lifecycle preamble on the left and a raw
// model id on the right ("You are working in the Ass…            gpt-5.6-sol"). Naming the
// model up front and following it with the feature reads as one thought and costs no width.

/** Friendly names we recognise inside provider model ids. Deliberately tiny: this is a
 *  presentation nicety, not a model registry, and anything unknown keeps its raw id. */
const FRIENDLY_NAMES = ['Sol', 'Terra', 'Luna', 'Fable', 'Opus', 'Sonnet', 'Haiku'] as const

/** Token boundary so `claude-haiku-4-5-20251001` matches Haiku while `solar-preview` does
 *  not match Sol. */
function matchesToken(modelLower: string, nameLower: string): boolean {
  const index = modelLower.indexOf(nameLower)
  if (index === -1) {
    return false
  }
  const before = index === 0 ? '' : modelLower[index - 1]
  const after = modelLower[index + nameLower.length] ?? ''
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)
}

/** `gpt-5.6-sol` -> `Sol`, `claude-fable-5` -> `Fable`, unknown ids unchanged. */
export function friendlyModel(model: string | undefined): string {
  const raw = model?.trim() ?? ''
  if (!raw) {
    return ''
  }
  const lower = raw.toLowerCase()
  for (const name of FRIENDLY_NAMES) {
    if (matchesToken(lower, name.toLowerCase())) {
      return name
    }
  }
  return raw
}

/** True when a feature name is already `Terra: …` / `Terra (medium): …`, so orchestration
 *  callers that format their own displayName are never double-prefixed. Any known name
 *  counts — `Terra: Sonnet: fix` would be worse than leaving the caller's label alone. */
function isAlreadyPrefixed(feature: string): boolean {
  return FRIENDLY_NAMES.some((name) =>
    new RegExp(`^${name}\\s*(\\([^)]*\\))?\\s*:`, 'i').test(feature)
  )
}

/**
 * Combine model, optional authoritative effort and feature name into one row label.
 * Effort is only ever rendered when a caller already knows it — nothing here infers it
 * from the model id.
 */
export function formatAgentRowLabel(args: {
  model?: string
  effort?: string
  feature: string
}): string {
  const feature = args.feature.trim()
  const name = friendlyModel(args.model)
  if (!name || isAlreadyPrefixed(feature)) {
    return feature
  }
  const effort = args.effort?.trim()
  const prefix = effort ? `${name} (${effort})` : name
  return feature ? `${prefix}: ${feature}` : prefix
}

/** True when the combined label already names the model, so the row can drop its
 *  separate raw-model chip instead of saying it twice. Case-insensitive to stay symmetric
 *  with isAlreadyPrefixed: a caller label like `terra: …` is preserved verbatim there, so
 *  a case-sensitive test here would leave the redundant chip on exactly those rows. */
export function labelNamesModel(label: string, model: string | undefined): boolean {
  const name = friendlyModel(model)
  return name !== '' && label.toLowerCase().startsWith(name.toLowerCase())
}
