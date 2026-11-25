import { buildPaletteDocument, type PaletteDocument } from './palette-document'
import type { PaletteVisibleFieldSource } from './indexed-field'

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
 * Every tab field is visible identity text, so tokens combine freely — a tab has
 * no hidden supporting evidence in phase 2.
 */
export function buildPaletteTabDocument(input: PaletteTabDocumentInput): PaletteDocument {
  const fields: PaletteVisibleFieldSource[] = [
    {
      id: PALETTE_TAB_TITLE_FIELD_ID,
      profile: 'structured-label',
      text: input.title,
      role: 'primary',
      destinationEligible: true
    },
    {
      id: PALETTE_TAB_WORKTREE_FIELD_ID,
      profile: 'structured-label',
      text: input.worktreeName,
      role: 'container',
      destinationEligible: false
    },
    {
      id: PALETTE_TAB_BRANCH_FIELD_ID,
      profile: 'structured-label',
      text: input.branch,
      role: 'container',
      destinationEligible: false
    },
    {
      id: PALETTE_TAB_REPO_FIELD_ID,
      profile: 'structured-label',
      text: input.repoName,
      role: 'container',
      destinationEligible: false
    },
    {
      id: PALETTE_TAB_WORKSPACE_FIELD_ID,
      profile: 'structured-label',
      text: input.workspaceLabel ?? '',
      role: 'container',
      destinationEligible: false
    }
  ]

  for (const [index, text] of input.secondaryTexts.entries()) {
    fields.push({
      id: paletteTabSecondaryFieldId(index),
      profile: 'path',
      text,
      role: 'secondary',
      destinationEligible: true
    })
  }

  for (const [index, alias] of (input.typeAliases ?? []).entries()) {
    fields.push({
      id: paletteTabAliasFieldId(index),
      profile: 'exact-alias',
      text: alias,
      role: 'alias',
      destinationEligible: false
    })
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
