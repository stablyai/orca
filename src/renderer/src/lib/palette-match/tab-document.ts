import { normalizePaletteText } from './normalized-text'
import { buildPaletteDocument, type PaletteDocument } from './palette-document'
import type { PaletteFieldSource } from './indexed-field'

export const PALETTE_TAB_TITLE_FIELD_ID = 'title'
export const PALETTE_TAB_WORKTREE_FIELD_ID = 'worktree'
export const PALETTE_TAB_BRANCH_FIELD_ID = 'branch'
export const PALETTE_TAB_REPO_FIELD_ID = 'repo'
export const PALETTE_TAB_WORKSPACE_FIELD_ID = 'workspace'
export const PALETTE_TAB_SECONDARY_FIELD_PREFIX = 'secondary:'
export const PALETTE_TAB_ALIAS_FIELD_PREFIX = 'alias:'

export type PaletteTabDocumentInput = {
  id: string
  title: string
  /** Paths and URLs shown or resolvable on the row, in display preference order. */
  secondaryTexts: readonly string[]
  worktreeName: string
  branch: string
  repoName: string
  /** Only pass a label the row actually renders or accessibly announces. */
  workspaceLabel?: string
  typeAliases?: readonly string[]
}

export function paletteTabSecondaryFieldId(index: number): string {
  return `${PALETTE_TAB_SECONDARY_FIELD_PREFIX}${index}`
}

export function paletteTabAliasFieldId(index: number): string {
  return `${PALETTE_TAB_ALIAS_FIELD_PREFIX}${index}`
}

export function parsePaletteTabIndexedFieldId(fieldId: string, prefix: string): number | null {
  if (!fieldId.startsWith(prefix)) {
    return null
  }
  const index = Number.parseInt(fieldId.slice(prefix.length), 10)
  return Number.isInteger(index) ? index : null
}

/**
 * Tab rows repeat the same string across fields — a browser title that is its own
 * URL, or a relative path contained in its absolute one. Indexing both would
 * inflate field-hop counts without adding a way to explain the match.
 */
function dedupeSecondaryTexts(
  title: string,
  secondaryTexts: readonly string[]
): { index: number; text: string }[] {
  const seen = new Set([normalizePaletteText(title.trim()).normalized])
  const kept: { index: number; text: string }[] = []
  for (const [index, text] of secondaryTexts.entries()) {
    const trimmed = text.trim()
    if (!trimmed) {
      continue
    }
    const normalized = normalizePaletteText(trimmed).normalized
    if (seen.has(normalized) || [...seen].some((existing) => existing.includes(normalized))) {
      continue
    }
    seen.add(normalized)
    kept.push({ index, text: trimmed })
  }
  return kept
}

/**
 * Every tab field is visible identity text, so tokens combine freely — a tab has
 * no hidden supporting evidence in phase 2.
 */
export function buildPaletteTabDocument(input: PaletteTabDocumentInput): PaletteDocument {
  const fields: PaletteFieldSource[] = [
    { id: PALETTE_TAB_TITLE_FIELD_ID, profile: 'structured-label', text: input.title },
    { id: PALETTE_TAB_WORKTREE_FIELD_ID, profile: 'structured-label', text: input.worktreeName },
    { id: PALETTE_TAB_BRANCH_FIELD_ID, profile: 'structured-label', text: input.branch },
    { id: PALETTE_TAB_REPO_FIELD_ID, profile: 'structured-label', text: input.repoName },
    {
      id: PALETTE_TAB_WORKSPACE_FIELD_ID,
      profile: 'structured-label',
      text: input.workspaceLabel ?? ''
    }
  ]

  for (const secondary of dedupeSecondaryTexts(input.title, input.secondaryTexts)) {
    fields.push({
      id: paletteTabSecondaryFieldId(secondary.index),
      profile: 'path',
      text: secondary.text
    })
  }

  for (const [index, alias] of (input.typeAliases ?? []).entries()) {
    fields.push({ id: paletteTabAliasFieldId(index), profile: 'exact-alias', text: alias })
  }

  return buildPaletteDocument({
    id: input.id,
    visibleFields: fields,
    compositePairs: [
      { leftFieldId: PALETTE_TAB_REPO_FIELD_ID, rightFieldId: PALETTE_TAB_BRANCH_FIELD_ID },
      { leftFieldId: PALETTE_TAB_REPO_FIELD_ID, rightFieldId: PALETTE_TAB_WORKTREE_FIELD_ID }
    ],
    evidence: []
  })
}
