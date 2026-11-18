import type { AgentProcessIdentity } from '../../agent-status/process/agent-process-presence'
import type { ProcessTableRow } from '../../process-observation/tables/process-table-snapshot'
import {
  MAX_ANCESTRY_DEPTH,
  agentOf,
  collectRows,
  isTmuxServer,
  type HookPaneProcessIo
} from './hook-process-root-evidence'

/** Whether a tmux server, not the pane, keeps the pane's agent alive: a tmux client holds the
 *  pane's foreground and the agent's known process runs outside the pane. */
export type PaneTmuxHostReader = (request: {
  paneKey: string
  worktreeId: string | undefined
  process?: AgentProcessIdentity
}) => Promise<boolean>

export async function readPaneTmuxHost(
  io: Pick<HookPaneProcessIo, 'resolveRoot' | 'readProcesses' | 'readTerminal'>,
  request: Parameters<PaneTmuxHostReader>[0]
): Promise<boolean> {
  const root = await io.resolveRoot(request.paneKey, request.worktreeId)
  if (!root || root === 'legacy') {
    return false
  }
  const rows = await collectRows(io, root.pid, request.process?.pid ?? root.pid)
  if (!rows) {
    return false
  }
  const rootRow = rows.find((row) => row.pid === root.pid)
  if (!rootRow?.tpgid || rootRow.tpgid <= 0) {
    return false
  }
  const client = rows.find(
    (row) => row.tty === rootRow.tty && row.pgid === rootRow.tpgid && isTmuxServer(row)
  )
  if (!client) {
    return false
  }
  // Without a process, a pane whose own agent sits beside the client (a stopped job) proves nothing.
  if (!request.process) {
    const clientChain = new Set<number>()
    for (let row: ProcessTableRow | undefined = client; row && !clientChain.has(row.pid);) {
      clientChain.add(row.pid)
      const parent: number = row.ppid
      row = rows.find((candidate) => candidate.pid === parent)
    }
    return rows.every(
      (row) =>
        row.tty !== rootRow.tty ||
        clientChain.has(row.pid) ||
        row.pgid === rootRow.tpgid ||
        agentOf(row.command) === undefined
    )
  }
  // Only a complete ancestry outside the pane proves it; a missing row proves nothing.
  let agent = rows.find((row) => row.pid === request.process?.pid)
  for (let depth = 0; agent && depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (agent.pid === root.pid) {
      return false
    }
    if (agent.ppid <= 1) {
      return true
    }
    const parent = agent.ppid
    agent = rows.find((row) => row.pid === parent)
  }
  return false
}
