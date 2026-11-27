// A new bot's first screen, read from its Home Chat: Orca's kickoff turn until the bot speaks, and why
// that turn failed. The desktop and the phone draw it from the same transcript.
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import type { AgentSessionLatestTurn } from '../agent-session/agent-session-wire'
import type { AgentJournalSubmission } from '../agent-session/journal/agent-session-journal-types'
import { nativeChatBotCardsOf } from '../native-chat/bot-cards/native-chat-bot-card-kind'
import type { BotSetupRefusal } from './bot-setup-steps'
import {
  agentSessionFailureDetailText,
  readAgentSessionFailureFact
} from '../agent-session/failures/agent-session-failure'
import type { AgentSessionAccountKind } from '../agent-session/failures/agent-session-availability'

/** `failed`: the first turn ended without a word. `turn` is what it did, for its checklist.
 *  `refused`: why the host refused the kickoff before any turn opened (its agent did not start). */
export type NativeChatFirstScreen = {
  phase: 'starting' | 'failed'
  turn: readonly NativeChatMessage[]
  refused: BotSetupRefusal | null
}

// Each row's answer, kept per row object: while the kickoff turn streams, only the row whose text
// moved is read again.
const firstScreenFacts = new WeakMap<NativeChatMessage, { spoke: boolean; imported: boolean }>()

function firstScreenFactsOf(message: NativeChatMessage): { spoke: boolean; imported: boolean } {
  let facts = firstScreenFacts.get(message)
  if (!facts) {
    facts = {
      spoke:
        message.role === 'assistant' &&
        message.blocks.some((block) => block.type === 'text' && block.text.trim() !== ''),
      imported: message.blocks.some(
        (block) =>
          block.type === 'text' &&
          nativeChatBotCardsOf(block).some(
            (card) => card.kind === 'importPlan' || card.kind === 'importDone'
          )
      )
    }
    firstScreenFacts.set(message, facts)
  }
  return facts
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
  const spoke = turn.some((message) => firstScreenFactsOf(message).spoke)
  // An import's plan is the bot's answer, and waits on the owner: the screen gives way to it at once.
  const imported = turn.some((message) => firstScreenFactsOf(message).imported)
  if (imported) {
    return null
  }
  // The transcript shows from the bot's first words, live, as the rest of its turn streams.
  if (spoke) {
    return null
  }
  return { phase: turnEnded ? 'failed' : 'starting', turn, refused }
}

export type KickoffSession = {
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
  const fact = readAgentSessionFailureFact(latest.rejection)
  const providerDetail = agentSessionFailureDetailText(fact)
  return {
    reason: latest.reason ?? '',
    ...(providerDetail ? { providerDetail } : {}),
    ...(fact ? { kind: fact.kind } : {}),
    ...(fact?.kind === 'notSignedIn'
      ? { notSignedIn: fact.account ? { account: fact.account } : {} }
      : {})
  }
}

/** The sign-in a failed first screen is waiting on: the kickoff's refusal, or its turn's failure
 *  line; null when it failed for another reason. */
export function nativeChatFirstScreenSignIn(
  firstScreen: NativeChatFirstScreen | null
): { account?: AgentSessionAccountKind } | null {
  if (firstScreen?.phase !== 'failed') {
    return null
  }
  if (firstScreen.refused) {
    return firstScreen.refused.notSignedIn ?? null
  }
  const failure = firstScreen.turn
    .flatMap((message) => message.blocks)
    .findLast((block) => block.type === 'text' && block.failure !== undefined)
  const fact = failure?.type === 'text' ? failure.failure : undefined
  return fact?.kind === 'notSignedIn' ? (fact.account ? { account: fact.account } : {}) : null
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
