import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { ClaudeConfigProfile } from '../../../../shared/claude-config-profiles'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

/** One terminal row per profile, beside the Claude row they derive from; profile folders exist only on this computer. */
export function claudeConfigProfileRows(
  claude: NewTabAgentMenuRow | undefined,
  profiles: readonly ClaudeConfigProfile[] | undefined
): NewTabAgentMenuRow[] {
  if (!claude || claude.agent !== 'claude' || !profiles?.length) {
    return []
  }
  const host = claude.executionHostId
  if (host !== undefined && parseExecutionHostId(host)?.kind !== 'local') {
    return []
  }
  return profiles.map((profile) => ({
    kind: claude.kind === 'terminal' ? 'terminal' : 'cli',
    agent: 'claude',
    ...(host !== undefined ? { executionHostId: host } : {}),
    claudeConfigProfile: { id: profile.id, label: profile.label }
  }))
}

/** Insert profile rows after Claude's terminal row, or at the start of the terminal group when Claude opens as a chat. */
export function withClaudeConfigProfileRows(
  rows: readonly NewTabAgentMenuRow[],
  profiles: readonly ClaudeConfigProfile[] | undefined,
  detectedIds: readonly TuiAgent[] | null
): readonly NewTabAgentMenuRow[] {
  const claude = rows.find(
    (row) =>
      row.agent === 'claude' &&
      (row.kind === 'cli' ||
        row.kind === 'terminal' ||
        (row.kind === 'chat' && Boolean(detectedIds?.includes('claude'))))
  )
  const added = claudeConfigProfileRows(claude, profiles)
  if (!claude || added.length === 0) {
    return rows
  }
  const firstCli = rows.findIndex((row) => row.kind === 'cli')
  const at =
    claude.kind === 'chat' ? (firstCli === -1 ? rows.length : firstCli) : rows.indexOf(claude) + 1
  return [...rows.slice(0, at), ...added, ...rows.slice(at)]
}
