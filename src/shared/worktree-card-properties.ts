import type { WorktreeCardProperty } from './types'

export const ALWAYS_VISIBLE_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  'status',
  'unread',
  'issue',
  'pr',
  'comment'
]

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  ...ALWAYS_VISIBLE_WORKTREE_CARD_PROPERTIES,
  // Why: agent activity is the primary reason users opt into the feature, so
  // show it inline on each card by default. Unchecking this from the
  // Workspaces view options hides the inline list entirely.
  'inline-agents'
]

export function normalizeWorktreeCardProperties(
  properties: readonly WorktreeCardProperty[] | null | undefined
): WorktreeCardProperty[] {
  const normalized = [...ALWAYS_VISIBLE_WORKTREE_CARD_PROPERTIES]
  const source = properties ?? DEFAULT_WORKTREE_CARD_PROPERTIES
  for (const property of source) {
    if (!normalized.includes(property)) {
      normalized.push(property)
    }
  }
  return normalized
}
