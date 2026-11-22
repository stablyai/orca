// Agents open in the workspaces under a bot's home (handed to it), here or on a paired computer: they
// work for the bot, so Activity shows the live ones as workers and their approvals reach Needs you.
// One another coordinator started keeps that Dispatch: its mail still goes to that coordinator, and
// the bot takes it over by asking it (the take-over skill), never by rewriting the Dispatch.
import { agentRowDotState } from '../agent-row-dot-state'
import { botWorkerTool, clipActivityTitle } from './bot-activity-recorded-workers'
import type { BotActivityStatus, BotWorkerRow } from './bot-activity-model'

export type BotHandedAgentObservation = {
  paneKey: string
  entry: BotActivityStatus
  worktreeId: string
  /** A Dispatch's task, when another coordinator started it. */
  taskTitle?: string
  /** The paired computer it runs on; absent on this computer. */
  hostId?: `runtime:${string}`
}

export function handedAgentRows(agents: readonly BotHandedAgentObservation[]): BotWorkerRow[] {
  return agents.flatMap((agent) => {
    const dot = agentRowDotState(agent.entry.state, agent.entry.workingMode)
    if (dot === 'done' || dot === 'failed') {
      return []
    }
    return [
      {
        kind: 'worker' as const,
        key: `agent:${agent.hostId ?? 'local'}:${agent.paneKey}`,
        // Not this bot's Dispatch: nothing for its Stop to stop.
        dispatchId: '',
        title: clipActivityTitle(agent.taskTitle || agent.entry.prompt || ''),
        dot,
        // It was started in its own workspace, before the bot had it.
        origin: { kind: 'session' as const, label: worktreeFolderName(agent.worktreeId) },
        paneKey: agent.paneKey,
        workspaceId: agent.worktreeId,
        ...(agent.hostId ? { hostId: agent.hostId } : {}),
        at: agent.entry.stateStartedAt ?? 0,
        worker: null,
        ...botWorkerTool(agent.entry, dot)
      }
    ]
  })
}

/** A worktree id is `<repo>::<path>`; its folder is what the sidebar names it by default. */
function worktreeFolderName(worktreeId: string): string {
  const path = worktreeId.slice(worktreeId.indexOf('::') + 2)
  return path.split(/[\\/]/).findLast(Boolean) ?? worktreeId
}
