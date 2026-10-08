import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { currentOwner } from './agent-hook-presence-transition'
import type { CommandEnd, FinishedCommand } from './command-foreground-tracker'

/** Whether a pane's finished command ended the agent its row reports. One rule for main (local and
 *  WSL panes) and the relay (SSH panes). An owner with a process is decided by the host's process
 *  check instead, and an ended owner or resume remnant holds nothing to end. */
export function commandEndEndsRow(
  row: AgentHookEventPayload | undefined,
  rowUpdatedAt: number | undefined,
  command: CommandEnd
): boolean {
  // Why: a row reported after the command ended (a run's own Done) is newer than that end.
  if (
    !row ||
    row.providerSessionOnly ||
    row.agentPresence?.ended ||
    (rowUpdatedAt !== undefined && rowUpdatedAt >= command.finishedAt)
  ) {
    return false
  }
  const owner = currentOwner(row)
  if (owner?.process) {
    return false
  }
  const agent = owner?.agent ?? row.payload.agentType
  if (!agent || agent === 'unknown') {
    return false
  }
  const { foreground, startedAt } = command
  if (foreground.kind === 'agent') {
    return foreground.agent === agent
  }
  // Why: a hook agent reporting under another program runs elsewhere, but a row painted from the
  // pane's output has no process of its own, so the command that printed it is its agent.
  if (foreground.kind === 'program' && owner) {
    return false
  }
  // Why: with no read naming the command, the agent that reported during it is taken as its
  // foreground, as the renderer's command-end drop did.
  return startedAt === null || (rowUpdatedAt !== undefined && rowUpdatedAt >= startedAt)
}

/** A host's `endsRow` check, confirmed by a fresh read that the pane's prompt really returned. */
export async function confirmCommandEnd(
  endsRow: () => boolean,
  command: FinishedCommand
): Promise<boolean> {
  // Why re-check after the read: the row may have moved on while the host read the terminal.
  return endsRow() && (await command.promptReturned()) && endsRow()
}
