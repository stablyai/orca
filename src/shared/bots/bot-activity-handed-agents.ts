// Agents open in the workspaces under a bot's home (handed to it), here or on a paired computer: they
// work for the bot, so Activity shows the live ones as workers and their approvals reach Needs you.
// One another coordinator started keeps that Dispatch: its mail still goes to that coordinator, and
// the bot takes it over by asking it (the take-over skill), never by rewriting the Dispatch.
import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import { agentRowDotState } from '../agent-row-dot-state'
import {
  AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
  AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE
} from '../agent-session/lifecycle/stopping/agent-session-restart-continuation'
import { parseAskFromStatus } from '../native-chat/input/native-chat-ask'
import { botWorkerTool, clipActivityTitle } from './bot-activity-recorded-workers'
import type { BotActivityStatus, BotWorkerRow } from './bot-activity-model'

export type BotHandedAgentObservation = {
  paneKey: string
  /** With its open question's full input, which its title can read. */
  entry: BotActivityStatus & Pick<AgentStatusEntry, 'interactivePrompt'>
  worktreeId: string
  /** A Dispatch's task, when another coordinator started it. */
  taskTitle?: string
  /** The session's own name (rename, chat or live title); absent from older hosts. */
  title?: string
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
        title: clipActivityTitle(handedAgentTitle(agent)),
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

/** Orca writes these prompts itself (mail, restart notes), so they never name the agent's work. */
function isOrcaWrittenPrompt(prompt: string): boolean {
  return (
    prompt.startsWith('──── From: ') ||
    prompt.startsWith(AGENT_SESSION_RESTART_CONTINUATION_MESSAGE) ||
    prompt.startsWith(AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE)
  )
}

function handedAgentTitle(agent: BotHandedAgentObservation): string {
  const question = parseAskFromStatus(agent.entry.interactivePrompt, agent.entry.toolName)
    ?.questions[0]?.question
  const prompt = agent.entry.prompt.trim()
  return (
    agent.taskTitle ||
    agent.title ||
    question ||
    (prompt && !isOrcaWrittenPrompt(prompt) ? prompt : '') ||
    worktreeFolderName(agent.worktreeId)
  )
}

/** A worktree id is `<repo>::<path>`; its folder is what the sidebar names it by default. */
function worktreeFolderName(worktreeId: string): string {
  const path = worktreeId.slice(worktreeId.indexOf('::') + 2)
  return path.split(/[\\/]/).findLast(Boolean) ?? worktreeId
}
