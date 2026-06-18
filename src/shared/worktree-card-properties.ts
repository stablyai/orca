import type {
  GlobalSettings,
  PersistedUIState,
  WorktreeCardMode,
  WorktreeCardProperty
} from './types'

const FIXED_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['status', 'unread']

export const TASK_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['issue', 'linear-issue']

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  ...FIXED_WORKTREE_CARD_PROPERTIES,
  ...TASK_WORKTREE_CARD_PROPERTIES,
  'pr',
  'automation',
  'comment',
  'ports',
  // Why: agent activity is the primary reason users opt into the feature, so
  // the Default mode keeps it inline on each card while Compact removes the
  // extra row.
  'inline-agents'
]

export const COMPACT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['status', 'automation']

const WORKTREE_CARD_PROPERTY_ORDER: WorktreeCardProperty[] = [
  'status',
  'unread',
  'ci',
  'branch',
  'issue',
  'linear-issue',
  'pr',
  'automation',
  'comment',
  'ports',
  'inline-agents'
]

export function normalizeWorktreeCardProperties(
  properties: readonly unknown[] | null | undefined
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

export function getWorktreeCardModeProperties(mode: WorktreeCardMode): WorktreeCardProperty[] {
  return mode === 'Compact'
    ? [...COMPACT_WORKTREE_CARD_PROPERTIES]
    : [...DEFAULT_WORKTREE_CARD_PROPERTIES]
}

export function getWorktreeCardModeUpdates(mode: WorktreeCardMode): {
  settings: Pick<GlobalSettings, 'compactWorktreeCards'>
  ui: Pick<PersistedUIState, 'worktreeCardProperties' | '_worktreeCardModeDefaulted'>
} {
  return {
    settings: { compactWorktreeCards: mode === 'Compact' },
    ui: {
      worktreeCardProperties: getWorktreeCardModeProperties(mode),
      _worktreeCardModeDefaulted: true
    }
  }
}
