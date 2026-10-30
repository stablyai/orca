import type { AgentStatusEntry } from '../agent-status-types'
import { isInterruptedStatusMessage, type NativeChatMessage } from '../native-chat-types'
import type { NativeChatSettledTurn, NativeChatSettledTurns } from '../native-chat-turn-status'
import { isNoiseMessage } from '../native-chat-noise'
import { shouldShowNativeChatWorking } from './native-chat-working-suppression'

/** shown prompts have a card in this pane; unshown prompts require input in the agent’s terminal. */
export type NativeChatAwaitingInput = 'shown' | 'unshown'

export type NativeChatTerminalTurn = {
  /** The agent is generating: drives Stop-vs-Send and the streaming preview. */
  isWorking: boolean
  /** Waiting on the reader keeps the turn active and its clock running. */
  turnActive: boolean
  awaitingInput: NativeChatAwaitingInput | null
}

export function resolveNativeChatTerminalTurn(args: {
  isConversation: boolean
  /** Hook 'working', reconciled with the transcript's turn boundaries. */
  working: boolean
  /** Hook 'waiting'/'blocked', reconciled the same way. */
  hookAwaitingInput: boolean
  interrupted: boolean
  hasPromptCard: boolean
}): NativeChatTerminalTurn {
  const { isConversation, working, hookAwaitingInput, interrupted, hasPromptCard } = args
  const turnActive = shouldShowNativeChatWorking({
    isConversation,
    working: working || hookAwaitingInput,
    interrupted
  })
  return {
    isWorking: shouldShowNativeChatWorking({ isConversation, working, interrupted }),
    turnActive,
    // A prompt only the terminal shows is the one wait the transcript has to report.
    awaitingInput: hasPromptCard ? 'shown' : turnActive && hookAwaitingInput ? 'unshown' : null
  }
}

type NativeChatHookTurnEntry = Pick<
  AgentStatusEntry,
  'state' | 'stateStartedAt' | 'turnStartedAt' | 'mainAgent' | 'sessionBoundary'
>

/** Prefer the host’s durable main-agent turn stamp; older hosts fall back to the main agent’s current-state start. */
export function nativeChatHookTurnStartedAt(
  entry: NativeChatHookTurnEntry | undefined
): number | null {
  if (!entry) {
    return null
  }
  if (entry.turnStartedAt !== undefined) {
    return entry.turnStartedAt
  }
  return entry.mainAgent && entry.mainAgent.state !== 'done'
    ? entry.mainAgent.stateStartedAt
    : entry.stateStartedAt
}

/** Return host-ended seconds, null to hide a silent unfinished turn, or undefined to preserve pane observations/old-host fallback. */
export function nativeChatHookLatestTurnWorkedSeconds(
  entry: NativeChatHookTurnEntry | undefined,
  hookSilent: boolean
): number | null | undefined {
  if (!entry) {
    return undefined
  }
  const mainAgent = entry.mainAgent ?? entry
  if (mainAgent.state === 'done') {
    return entry.sessionBoundary === true || entry.turnStartedAt === undefined
      ? undefined
      : Math.max(0, Math.floor((mainAgent.stateStartedAt - entry.turnStartedAt) / 1000))
  }
  return hookSilent ? null : undefined
}

export function nativeChatLatestTurnId(messages: readonly NativeChatMessage[]): string | null {
  const latest = messages.findLast((message) => message.role === 'user' && !isNoiseMessage(message))
  return latest?.id ?? null
}

/** Time finished turns within the transcript clock; ignore unrelated system rows and omit the latest or incomplete turn to preserve pane observations. */
export function nativeChatTranscriptSettledTurns(
  messages: readonly NativeChatMessage[]
): NativeChatSettledTurns {
  const settled = new Map<string, NativeChatSettledTurn>()
  let turn: { id: string; startedAt: number | null; endedAt: number | null } | null = null
  for (const message of messages) {
    // A harness notice is user-role but draws no row, so it neither starts nor extends a turn.
    if (message.role !== 'user' || isNoiseMessage(message)) {
      const agentRow =
        message.role === 'system' ? isInterruptedStatusMessage(message) : message.role !== 'user'
      if (turn && agentRow && message.timestamp != null) {
        turn.endedAt = Math.max(turn.endedAt ?? message.timestamp, message.timestamp)
      }
      continue
    }
    if (turn?.startedAt != null && turn.endedAt != null) {
      settled.set(turn.id, {
        startedAt: turn.startedAt,
        workedSeconds: Math.max(0, Math.floor((turn.endedAt - turn.startedAt) / 1000))
      })
    }
    turn = { id: message.id, startedAt: message.timestamp, endedAt: null }
  }
  return settled
}

/** Overlay the host's latest-turn timing on transcript durations once the turn settles. */
export function nativeChatTerminalSettledTurns(args: {
  transcriptSettled: NativeChatSettledTurns
  latestTurnId: string | null
  latestWorkedSeconds: number | null | undefined
  turnStartedAt: number | null
  turnActive: boolean
}): NativeChatSettledTurns {
  const { transcriptSettled, latestTurnId, latestWorkedSeconds, turnStartedAt, turnActive } = args
  if (turnActive || latestWorkedSeconds === undefined || latestTurnId === null) {
    return transcriptSettled
  }
  return new Map(transcriptSettled).set(
    latestTurnId,
    latestWorkedSeconds === null || turnStartedAt === null
      ? null
      : { startedAt: turnStartedAt, workedSeconds: latestWorkedSeconds }
  )
}
