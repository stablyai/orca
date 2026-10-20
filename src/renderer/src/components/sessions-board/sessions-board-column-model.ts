import {
  filterAiVaultSessions,
  groupAiVaultSessions
} from '../../../../shared/ai-vault-session-filters'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'

// Why: the board exists to show sessions the workspace-scoped panel cannot, so it
// filters at scope 'all'. The scan behind it is already machine-wide — `scopePaths`
// only ever widens discovery — which makes 'all' the honest description of the data.

export type SessionsBoardColumn = {
  agent: AiVaultAgent
  label: string
  sessions: AiVaultSession[]
}

export type SessionsBoardFilters = {
  query: string
  hideEmptySessions: boolean
}

export function buildSessionsBoardColumns(
  sessions: readonly AiVaultSession[],
  filters: SessionsBoardFilters
): SessionsBoardColumn[] {
  const filtered = filterAiVaultSessions(sessions, {
    query: filters.query,
    agents: AI_VAULT_AGENTS,
    scope: 'all',
    sort: 'updated',
    activeWorktreePaths: [],
    hideEmptySessions: filters.hideEmptySessions
  })
  // Grouping keys on `session.agent`, so the head session names the column with the
  // branded type the agent icon wants without a cast; a group is never empty.
  return groupAiVaultSessions(filtered, 'agent')
    .flatMap((group) => {
      const [head] = group.sessions
      return head ? [{ agent: head.agent, label: group.label, sessions: group.sessions }] : []
    })
    .sort(compareSessionsBoardColumns)
}

/** Busiest agent first, so the columns that matter stay on screen. */
function compareSessionsBoardColumns(
  left: SessionsBoardColumn,
  right: SessionsBoardColumn
): number {
  const byCount = right.sessions.length - left.sessions.length
  return byCount !== 0 ? byCount : left.label.localeCompare(right.label)
}
