import { normalizePaletteText, type NormalizedText } from './normalized-text'
import { segmentPaletteText, type PaletteAtom, type PaletteWord } from './text-segments'
import type { PaletteMatchQuality } from './match-quality'

export type PaletteFieldProfile =
  | 'structured-label'
  | 'identifier'
  | 'path'
  | 'prose'
  | 'exact-alias'

/**
 * Identifier kinds differ only in whether a partial value is meaningful; every
 * kind keeps exact/alias matching and per-atom separator normalization.
 */
export type PaletteIdentifierKind = 'number' | 'port' | 'sha' | 'version' | 'date' | 'key'

/** Sigils are provider-specific: `#123` is a PR, `!123` is an MR. */
export type PaletteIdentifierSigil = '#' | '!'

export type PaletteIdentifierOptions = {
  kind: PaletteIdentifierKind
  sigil?: PaletteIdentifierSigil
}

export type PaletteFieldRole = 'primary' | 'secondary' | 'alias' | 'container'

type PaletteFieldSourceBase = {
  id: string
  profile: PaletteFieldProfile
  text: string
  identifier?: PaletteIdentifierOptions
}

export type PaletteVisibleFieldSource = PaletteFieldSourceBase & {
  evidenceId?: null
  role: PaletteFieldRole
  destinationEligible: boolean
}

export type PaletteEvidenceFieldSource = PaletteFieldSourceBase & {
  evidenceId: string
  role?: never
  destinationEligible?: never
}

export type PaletteFieldSource = PaletteVisibleFieldSource | PaletteEvidenceFieldSource

export type PaletteIndexedField = {
  id: string
  /** Stable source order used to break otherwise-equivalent match proofs. */
  sourceOrder: number
  profile: PaletteFieldProfile
  text: NormalizedText
  atoms: readonly PaletteAtom[]
  words: readonly PaletteWord[]
  evidenceId: string | null
  identifier: PaletteIdentifierOptions | null
  role: PaletteFieldRole | null
  destinationEligible: boolean
}

const IDENTIFIER_PREFIX_KINDS: ReadonlySet<PaletteIdentifierKind> = new Set<PaletteIdentifierKind>([
  'port',
  'sha',
  'key'
])

export function identifierKindAllowsPrefix(kind: PaletteIdentifierKind): boolean {
  return IDENTIFIER_PREFIX_KINDS.has(kind)
}

const STRUCTURED_LABEL_QUALITIES: readonly PaletteMatchQuality[] = [
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix',
  'boundary-substring',
  'literal-substring',
  'compact',
  'typo'
]

const IDENTIFIER_QUALITIES: readonly PaletteMatchQuality[] = [
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix',
  'compact'
]

const PATH_QUALITIES: readonly PaletteMatchQuality[] = [
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix',
  'boundary-substring',
  'literal-substring'
]

const PROSE_QUALITIES: readonly PaletteMatchQuality[] = [
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix',
  'boundary-substring',
  'literal-substring',
  'typo'
]

const EXACT_ALIAS_QUALITIES: readonly PaletteMatchQuality[] = [
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix'
]

const QUALITIES_BY_PROFILE: Record<PaletteFieldProfile, readonly PaletteMatchQuality[]> = {
  'structured-label': STRUCTURED_LABEL_QUALITIES,
  identifier: IDENTIFIER_QUALITIES,
  path: PATH_QUALITIES,
  prose: PROSE_QUALITIES,
  'exact-alias': EXACT_ALIAS_QUALITIES
}

export function paletteProfileAllowedQualities(
  profile: PaletteFieldProfile
): readonly PaletteMatchQuality[] {
  return QUALITIES_BY_PROFILE[profile]
}

export function indexPaletteField(
  source: PaletteFieldSource,
  sourceOrder = 0
): PaletteIndexedField | null {
  const trimmed = source.text.trim()
  if (!trimmed) {
    return null
  }
  const text = normalizePaletteText(trimmed)
  const segments = segmentPaletteText(text)
  return {
    id: source.id,
    sourceOrder,
    profile: source.profile,
    text,
    atoms: segments.atoms,
    words: segments.words,
    evidenceId: source.evidenceId ?? null,
    identifier: source.identifier ?? null,
    role: source.role ?? null,
    destinationEligible: source.destinationEligible === true
  }
}

export function indexPaletteFields(
  sources: readonly (PaletteFieldSource | null | undefined)[]
): PaletteIndexedField[] {
  const fields: PaletteIndexedField[] = []
  const seenIds = new Set<string>()
  for (const source of sources) {
    if (!source) {
      continue
    }
    const field = indexPaletteField(source, fields.length)
    if (field && !seenIds.has(field.id)) {
      seenIds.add(field.id)
      fields.push(field)
    }
  }
  return fields
}
