import type { GlobalSettings } from '../global-settings-types'
import type { PersistedUIState } from '../persisted-ui-state-types'
import type { WorktreeCardMode, WorktreeCardProperty } from '../ui-chrome-types'

const FIXED_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['status', 'unread']

export const TASK_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  'issue',
  'linear-issue',
  'jira-issue'
]

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  ...FIXED_WORKTREE_CARD_PROPERTIES,
  ...TASK_WORKTREE_CARD_PROPERTIES,
  'pr',
  'automation',
  'cli',
  'comment',
  'ports',
  // Default cards keep agent activity inline; Compact omits the extra row.
  'inline-agents',
  'host'
]

// Compact metadata stays opt-in through Show properties.
export const COMPACT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['status']
const NORMALIZED_COMPACT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = ['status', 'unread']

const LEGACY_COMPACT_WORKTREE_CARD_PROPERTIES_WITH_AUTOMATION: WorktreeCardProperty[] = [
  'status',
  'automation'
]

const LEGACY_NORMALIZED_COMPACT_WORKTREE_CARD_PROPERTIES_WITH_AUTOMATION: WorktreeCardProperty[] = [
  'status',
  'unread',
  'automation'
]

/** Canonical render order also defines client schema domains to prevent drift. */
export const WORKTREE_CARD_PROPERTIES = [
  'status',
  'unread',
  'ci',
  'branch',
  'issue',
  'linear-issue',
  'jira-issue',
  'pr',
  'automation',
  'cli',
  'comment',
  'ports',
  'inline-agents',
  'host'
] as const satisfies readonly WorktreeCardProperty[]

export function normalizeWorktreeCardProperties(
  properties: readonly unknown[] | null | undefined
): WorktreeCardProperty[] {
  const normalized: WorktreeCardProperty[] = [...FIXED_WORKTREE_CARD_PROPERTIES]
  const source = properties ?? DEFAULT_WORKTREE_CARD_PROPERTIES
  for (const property of WORKTREE_CARD_PROPERTIES) {
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

/** Raw and normalized (UI-write) forms of today's Compact preset. */
export function isCurrentCompactWorktreeCardProperties(
  properties: readonly unknown[] | null | undefined
): boolean {
  return (
    matchesWorktreeCardProperties(properties, COMPACT_WORKTREE_CARD_PROPERTIES) ||
    matchesWorktreeCardProperties(properties, NORMALIZED_COMPACT_WORKTREE_CARD_PROPERTIES)
  )
}

export function isDefaultedCompactWorktreeCardProperties(
  properties: readonly unknown[] | null | undefined
): boolean {
  return (
    isCurrentCompactWorktreeCardProperties(properties) ||
    matchesWorktreeCardProperties(
      properties,
      LEGACY_COMPACT_WORKTREE_CARD_PROPERTIES_WITH_AUTOMATION
    ) ||
    matchesWorktreeCardProperties(
      properties,
      LEGACY_NORMALIZED_COMPACT_WORKTREE_CARD_PROPERTIES_WITH_AUTOMATION
    )
  )
}

function matchesWorktreeCardProperties(
  properties: readonly unknown[] | null | undefined,
  expected: readonly WorktreeCardProperty[]
): boolean {
  if (properties?.length !== expected.length) {
    return false
  }
  return expected.every((property, index) => properties[index] === property)
}

/** Shared card projection; desktop additionally applies dense title/SSH rules. */
export type WorktreeCardDetails = {
  /** The Compact layout as it applies: the new card style overrides it. */
  compactCards: boolean
  /** Repo identity sits in the title row, not the meta row (compact cards and the new card style).
   *  Read by the phone row and the desktop card's repo badge. */
  repoInTitle: boolean
  /** The identity meta row (repo, host, branch or folder path, detached HEAD); compact cards drop it. */
  metaRow: boolean
  issue: boolean
  linearIssue: boolean
  jiraIssue: boolean
  pr: boolean
  automation: boolean
  cli: boolean
  comment: boolean
  ports: boolean
  /** The host badge, which sits in the meta row. */
  host: boolean
  /** The agent rows under a card; compact cards leave them out. */
  inlineAgents: boolean
}

/** Reads the desktop's raw settings, so no caller resolves the layout on its own. */
export function getWorktreeCardDetails(
  cardProps: readonly WorktreeCardProperty[],
  settings: { compactWorktreeCards: boolean; newCardStyle: boolean }
): WorktreeCardDetails {
  const compactCards = !settings.newCardStyle && settings.compactWorktreeCards
  const metaRow = !compactCards
  const shows = (property: WorktreeCardProperty) => cardProps.includes(property)
  return {
    compactCards,
    repoInTitle: settings.newCardStyle || compactCards,
    metaRow,
    issue: shows('issue'),
    linearIssue: shows('linear-issue'),
    jiraIssue: shows('jira-issue'),
    pr: shows('pr'),
    automation: shows('automation'),
    cli: shows('cli'),
    comment: shows('comment'),
    ports: shows('ports'),
    host: metaRow && shows('host'),
    inlineAgents: !compactCards && shows('inline-agents')
  }
}
