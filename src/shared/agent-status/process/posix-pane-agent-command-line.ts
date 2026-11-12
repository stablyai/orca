import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../process-table-index'
import { getFreshShellForegroundSnapshot } from '../../process-table-snapshot-reader'
import type { AgentProcessIdentity } from './agent-process-presence'
import { probeAgentProcessPresence } from './agent-process-presence-probe'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

export type LineageCommandRow = {
  pid: number
  ppid: number
  command: string
}

export function selectUniqueRootAgentCommand<T extends LineageCommandRow>(
  matching: readonly T[],
  allRows: readonly { pid: number; ppid: number }[]
): string | null {
  if (matching.length === 0) {
    return null
  }
  const byPid = new Map(allRows.map((row) => [row.pid, row]))
  const matchingPids = new Set(matching.map((row) => row.pid))
  const hasMatchingAncestor = (candidate: T): boolean => {
    const visited = new Set<number>([candidate.pid])
    let current = byPid.get(candidate.ppid)
    while (current && !visited.has(current.pid)) {
      if (matchingPids.has(current.pid)) {
        return true
      }
      visited.add(current.pid)
      current = byPid.get(current.ppid)
    }
    return false
  }
  const roots = matching.filter((candidate) => !hasMatchingAncestor(candidate))
  return roots.length === 1 ? roots[0].command : null
}

/** Prefer the shallowest matching descendant of `shellPid`; fall back to a start-verified sender PID only when detached. */
export async function readPosixPaneAgentCommandLine(
  shellPid: number,
  agent: TuiAgent,
  sender?: AgentProcessIdentity
): Promise<string | null> {
  const rows = await getFreshShellForegroundSnapshot().catch(() => null)
  if (!rows) {
    return null
  }
  const descendants = collectDescendantsFromIndex(getProcessTableIndex(rows), shellPid)
  const matching = descendants.filter(
    (row) => recognizeAgentProcessFromCommandLine(row.command)?.agent === agent
  )
  const rootCommand = selectUniqueRootAgentCommand(matching, descendants)
  if (rootCommand !== null || matching.length > 0) {
    return rootCommand
  }
  if (sender?.pid && sender.startTime && (await probeAgentProcessPresence(sender)) === 'live') {
    const bySender = rows.find((row) => row.pid === sender.pid)
    if (bySender && recognizeAgentProcessFromCommandLine(bySender.command)?.agent === agent) {
      return bySender.command
    }
  }
  return null
}
