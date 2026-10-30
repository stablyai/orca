import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultListRow } from './AiVaultVirtualRow'

/** Presets for how many sessions each group header shows before a Show more row. */
export const AI_VAULT_GROUP_SESSION_LIMITS = [3, 5, 10, 'all'] as const

export type AiVaultGroupSessionLimit = (typeof AI_VAULT_GROUP_SESSION_LIMITS)[number]

export const DEFAULT_AI_VAULT_GROUP_SESSION_LIMIT: AiVaultGroupSessionLimit = 'all'

export function normalizeAiVaultGroupSessionLimit(value: unknown): AiVaultGroupSessionLimit {
  return (
    AI_VAULT_GROUP_SESSION_LIMITS.find((limit) => limit === value) ??
    DEFAULT_AI_VAULT_GROUP_SESSION_LIMIT
  )
}

/**
 * Flattens groups into virtual-list rows. Headered groups longer than the limit show
 * their first sessions (already in the active sort order) plus a row that reveals the rest.
 */
export function buildAiVaultListRows(args: {
  groups: readonly AiVaultSessionListGroup[]
  collapsedGroups: ReadonlySet<string>
  groupSessionLimit: AiVaultGroupSessionLimit
  expandedGroups: ReadonlySet<string>
}): AiVaultListRow[] {
  const rows: AiVaultListRow[] = []
  for (const sessionGroup of args.groups) {
    const label = sessionGroup.label
    if (label !== null) {
      rows.push({ type: 'group', group: { ...sessionGroup, label } })
      if (args.collapsedGroups.has(sessionGroup.key)) {
        continue
      }
    }
    // Why: label-less groups (search results) have no header to anchor a per-group cap.
    const limit = label === null ? 'all' : args.groupSessionLimit
    const total = sessionGroup.sessions.length
    const truncatable = limit !== 'all' && total > limit
    const expanded = truncatable && args.expandedGroups.has(sessionGroup.key)
    const visible =
      truncatable && !expanded ? sessionGroup.sessions.slice(0, limit) : sessionGroup.sessions
    for (const session of visible) {
      rows.push({ type: 'session', groupKey: sessionGroup.key, session })
    }
    if (truncatable) {
      rows.push({
        type: 'group-more',
        groupKey: sessionGroup.key,
        hiddenCount: total - limit,
        expanded
      })
    }
  }
  return rows
}
