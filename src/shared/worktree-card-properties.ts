import type { WorktreeCardProperty } from './types'

const FIXED_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['status', 'unread']

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  ...FIXED_WORKTREE_CARD_PROPERTIES,
  'issue',
  'linear-issue',
  'pr',
  'comment',
  'ports',
  // Why: agent activity is the primary reason users opt into the feature, so
  // show it inline on each card by default. Unchecking this from the
  // Workspaces view options hides the inline list entirely.
  'inline-agents'
]

const WORKTREE_CARD_PROPERTY_ORDER: WorktreeCardProperty[] = [
  'status',
  'unread',
  'ci',
  'issue',
  'linear-issue',
  'pr',
  'comment',
  'ports',
  'inline-agents'
]

export function normalizeWorktreeCardProperties(
  properties: readonly WorktreeCardProperty[] | null | undefined
): WorktreeCardProperty[] {
  const normalized: WorktreeCardProperty[] = [...FIXED_WORKTREE_CARD_PROPERTIES]
  const source = properties ?? DEFAULT_WORKTREE_CARD_PROPERTIES
  for (const property of WORKTREE_CARD_PROPERTY_ORDER) {
    if (source.includes(property) && !normalized.includes(property)) {
      normalized.push(property)
    }
  }
  return normalized
}
