import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isInterruptedStatusMessage,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import type {
  NativeChatSettledTurn,
  NativeChatSettledTurns
} from '../../../../shared/native-chat-turn-status'
import { isNoiseMessage } from '../../../../shared/native-chat-noise'
import type { NativeChatAwaitingInput } from './NativeChatMessageList'
import { shouldShowNativeChatWorking } from './native-chat-working-suppression'

export type NativeChatTerminalTurn = {
  /** The agent is generating: drives Stop-vs-Send and the streaming preview. */
  isWorking: boolean
  /** The turn is running, including while its agent waits on the reader, as a
   *  structured turn runs on behind its prompt card: its clock keeps counting. */
  turnActive: boolean
  awaitingInput: NativeChatAwaitingInput | null
}

/** The turn facts a terminal-backed pane feeds the shared turn-status UI. */
export function resolveNativeChatTerminalTurn(args: {
  isConversation: boolean
  /** Hook 'working', reconciled with the transcript's turn boundaries. */
  working: boolean
  /** Hook 'waiting'/'blocked', reconciled the same way. */
  hookAwaitingInput: boolean
  /** Local Stop suppression. */
  interrupted: boolean
  /** The pane draws the agent's prompt as a card. */
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

/**
 * When the pane's current turn began: the host's stamp from the main agent's own turn-opening
 * event, which survives a remount, a reload and child work holding the row open. A host too old to
 * stamp it leaves the current state's start, the main agent's while it is mid-turn.
 */
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

// Completed main-agent clocks survive readiness updates; unknown turn ends have no duration.
export function nativeChatHookLatestTurnWorkedSeconds(
  entry: NativeChatHookTurnEntry | undefined,
  hookSilent: boolean
): number | null | undefined {
  if (!entry) {
    return undefined
  }
  const mainAgent = entry.mainAgent ?? entry
  if (mainAgent.state === 'done') {
    return (entry.sessionBoundary === true && !entry.mainAgent) || entry.turnStartedAt === undefined
      ? undefined
      : Math.max(0, Math.floor((mainAgent.stateStartedAt - entry.turnStartedAt) / 1000))
  }
  return hookSilent ? null : undefined
}

/** The transcript's latest turn: its last prompt, harness notices aside. */
export function nativeChatLatestTurnId(messages: readonly NativeChatMessage[]): string | null {
  const latest = messages.findLast((message) => message.role === 'user' && !isNoiseMessage(message))
  return latest?.id ?? null
}

/**
 * Durations of the transcript's finished turns, from its own timestamps (one clock): a turn runs
 * from its prompt to the agent's last timestamped row or its interruption. Other system rows (file
 * mentions, extension notes) can land long after, next to the following prompt. The latest turn is
 * left out, since nothing here says it has ended, and so is a turn missing either end, which keeps
 * what the pane observed.
 */
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
