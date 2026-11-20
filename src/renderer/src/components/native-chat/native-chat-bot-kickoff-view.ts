// A new bot's Chat from Orca's kickoff: its first screen, Stop's hold, and sends on the owner's behalf.
import { createContext, useLayoutEffect, useMemo, useRef } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { nativeChatBotCardsOf } from '../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { useBotForWorkspace } from '../bots/bot-workspace'
import type { BotSetupRefusal } from '../../../../shared/bots/bot-setup-steps'
import {
  agentSessionFailureDetailText,
  readAgentSessionFailureFact
} from '../../../../shared/agent-session/failures/agent-session-failure'
import type { NativeChatStructuredComposerTransport } from './composer/submit/native-chat-structured-composer-transport'

export type NativeChatBotKickoffView = {
  /** The owner hasn't written since the latest kickoff. */
  live: boolean
  /** Sends as the owner; resolves false when the chat refused it. */
  send: (text: string) => Promise<boolean>
  /** Why the chat holds sends now, if it does. */
  sendBlockedReason: () => string | undefined
  /** The bot whose Chat it is. */
  bot: Bot | null
  /** A new bot's first turn until it has spoken, which its Home shows as its first screen. */
  firstScreen: NativeChatFirstScreen | null
  /** Orca's first kickoff, where the bot's header sits; a Try again sends later ones. */
  firstKickoffId: string | null
}

/** `failed`: the first turn ended without a word. `turn` is what it did, for its checklist.
 *  `refused`: why the host refused the kickoff before any turn opened (its agent did not start). */
export type NativeChatFirstScreen = {
  phase: 'starting' | 'failed'
  turn: readonly NativeChatMessage[]
  refused: BotSetupRefusal | null
}

export const NativeChatBotKickoffContext = createContext<NativeChatBotKickoffView | null>(null)

function nativeChatKickoffLive(messages: readonly NativeChatMessage[]): boolean {
  const kickoff = messages.findLastIndex((message) => message.orcaNotice === 'bot-created')
  return kickoff !== -1 && !messages.slice(kickoff + 1).some((message) => message.role === 'user')
}

/** Orca's kickoff turn until the bot speaks, or the owner writes; null for any other chat. */
export function nativeChatFirstScreen(
  messages: readonly NativeChatMessage[],
  turnEnded: boolean,
  refused: BotSetupRefusal | null = null
): NativeChatFirstScreen | null {
  // The latest kickoff: Try again sends another.
  const notice = messages.findLastIndex((message) => message.orcaNotice === 'bot-created')
  const turn = notice === -1 ? [] : messages.slice(notice + 1)
  if (notice === -1 || turn.some((message) => message.role === 'user')) {
    return null
  }
  const spoke = turn.some(
    (message) =>
      message.role === 'assistant' &&
      message.blocks.some((block) => block.type === 'text' && block.text.trim() !== '')
  )
  // An import's plan is the bot's answer, and waits on the owner: the screen gives way to it at once.
  const imported = turn.some((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'text' &&
        nativeChatBotCardsOf(block).some(
          (card) => card.kind === 'importPlan' || card.kind === 'importDone'
        )
    )
  )
  if (imported) {
    return null
  }
  // The transcript shows from the bot's first words, live, as the rest of its turn streams.
  if (spoke) {
    return null
  }
  return { phase: turnEnded ? 'failed' : 'starting', turn, refused }
}

type KickoffSession = {
  isWorking: boolean
  latestTurn?: AgentSessionLatestTurn | null
  submissions?: readonly Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'rejection'>[]
}

/** The host's reason when it refused the latest send before any turn opened; else null. */
export function nativeChatKickoffRefusal(session: KickoffSession): BotSetupRefusal | null {
  const latest = session.isWorking ? undefined : session.submissions?.at(-1)
  if (latest?.dispatchState !== 'rejected') {
    return null
  }
  const providerDetail = agentSessionFailureDetailText(
    readAgentSessionFailureFact(latest.rejection)
  )
  return { reason: latest.reason ?? '', ...(providerDetail ? { providerDetail } : {}) }
}

/** Ended once the host has a turn record that no longer runs, or refused the kickoff before any turn
 *  opened (its agent failed to start); before that the kickoff is still starting. */
export function nativeChatKickoffEnded(session: KickoffSession): boolean {
  if (session.isWorking) {
    return false
  }
  if (nativeChatKickoffRefusal(session) !== null) {
    return true
  }
  return session.latestTurn != null && session.latestTurn.turn.state !== 'running'
}

export function useNativeChatBotKickoffView(
  messages: readonly NativeChatMessage[],
  session: KickoffSession,
  transport: NativeChatStructuredComposerTransport,
  workspaceId: string | null
): NativeChatBotKickoffView {
  const bot = useBotForWorkspace(workspaceId)
  const latestTransport = useRef(transport)
  useLayoutEffect(() => {
    latestTransport.current = transport
  }, [transport])
  const live = useMemo(() => bot !== null && nativeChatKickoffLive(messages), [bot, messages])
  const turnEnded = nativeChatKickoffEnded(session)
  const refusal = nativeChatKickoffRefusal(session)
  // Keyed by its words, so a new object for the same refusal keeps the first screen.
  const refusedReason = refusal?.reason ?? null
  const refusedDetail = refusal?.providerDetail
  const firstScreen = useMemo(
    () =>
      live
        ? nativeChatFirstScreen(
            messages,
            turnEnded,
            refusedReason === null
              ? null
              : {
                  reason: refusedReason,
                  ...(refusedDetail ? { providerDetail: refusedDetail } : {})
                }
          )
        : null,
    [live, messages, turnEnded, refusedReason, refusedDetail]
  )
  const firstKickoffId =
    messages.find((message) => message.orcaNotice === 'bot-created')?.id ?? null
  return useMemo(
    () => ({
      live,
      bot,
      firstScreen,
      firstKickoffId,
      send: (text) =>
        Promise.resolve()
          .then(() => latestTransport.current.send(text, []))
          .then(
            (sent) => sent !== false,
            () => false
          ),
      sendBlockedReason: () => latestTransport.current.sendBlockedReason
    }),
    [live, bot, firstScreen, firstKickoffId]
  )
}
