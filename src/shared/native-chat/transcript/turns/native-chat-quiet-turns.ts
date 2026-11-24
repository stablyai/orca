import { isQuietBotResult, quietBotResultText } from '../../../bot-quiet-result'
import { isNativeChatOrcaCard } from '../../native-chat-orca-card'
import { nativeChatRowRunsPullRequestCreate } from '../../tools/native-chat-opened-pull-requests'
import type { NativeChatMessage } from '../../native-chat-types'
import { deriveNativeChatRowContent } from '../row-content/native-chat-row-content'
import type { NativeChatTurnStatus } from './native-chat-turn-status'

function fromOtherAgent(message: NativeChatMessage): boolean {
  return message.role === 'user' && message.from !== undefined
}

/** A row that opened the turn for the agent rather than a person typing to it: a hidden card answer,
 *  Orca's own notice, another agent's message (item, worker or chat mail) or an automation's run. */
function opensWithoutAsking(message: NativeChatMessage): boolean {
  return (
    message.orcaNotice === 'card-answer' ||
    message.orcaNotice === 'bot-created' ||
    message.automationRun !== undefined ||
    fromOtherAgent(message)
  )
}

/** A row a quiet turn still draws: Orca's cards, another agent's message and the automation run. */
function staysInQuietTurn(message: NativeChatMessage): boolean {
  return (
    (isNativeChatOrcaCard(message) && message.orcaNotice !== 'card-answer') ||
    message.automationRun !== undefined ||
    fromOtherAgent(message)
  )
}

/** Settled cleanly: a failed, interrupted or unconfirmed turn keeps its bar. */
function settledQuietly(status: NativeChatTurnStatus | undefined): boolean {
  return (
    status?.workedSeconds != null && (status.verdict === undefined || status.verdict === 'success')
  )
}

/** Settled turns that ended with only the quiet marker and that no person typed into. Their rows,
 *  "Worked for" bar and "Nothing to report" don't draw; what opened them (mail, an automation run)
 *  and the cards Orca drew during them (item changes, started workers) still do. A turn that ran a
 *  PR create command draws, as does one `keepsTurn` keeps for what else it left, such as a diff. A
 *  failed, interrupted or unconfirmed turn, and one holding someone's message (typed, steered in, or a connector
 *  delivery), draw. */
export function nativeChatQuietTurns(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>,
  keepsTurn: (turnKey: string) => boolean
): { rows: ReadonlySet<number>; turns: ReadonlySet<string> } {
  const asked = new Set<string>()
  const openedPullRequest = new Set<string>()
  const lastWords = new Map<string, string>()
  rows.forEach((message, index) => {
    const key = turnKeys[index]
    if (key === undefined) {
      return
    }
    if (message.role === 'user' && !opensWithoutAsking(message)) {
      asked.add(key)
    }
    if (nativeChatRowRunsPullRequestCreate(message)) {
      openedPullRequest.add(key)
    }
    if (message.role === 'assistant') {
      const words = deriveNativeChatRowContent(message.blocks).markdown
      if (words.trim()) {
        lastWords.set(key, words)
      }
    }
  })
  const turns = new Set(
    [...lastWords].flatMap(([key, words]) =>
      settledQuietly(completedByTurn[key]) &&
      !asked.has(key) &&
      !openedPullRequest.has(key) &&
      isQuietBotResult(words) &&
      quietBotResultText(words) === '' &&
      !keepsTurn(key)
        ? [key]
        : []
    )
  )
  const hidden = new Set<number>()
  rows.forEach((message, index) => {
    const key = turnKeys[index]
    if (key !== undefined && turns.has(key) && !staysInQuietTurn(message)) {
      hidden.add(index)
    }
  })
  return { rows: hidden, turns }
}
