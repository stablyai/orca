import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../agent-session/journal/agent-session-journal-types'
import { isQuietBotResult, quietBotResultText } from '../bot-quiet-result'
import { nativeChatRowRunsPullRequestCreate } from '../native-chat/tools/native-chat-opened-pull-requests'
import { structuredAgentTurnAnchors } from '../native-chat/transcript/turns/native-chat-turn-membership'
import type { BotGroupMessage, BotGroupTurn } from './bot-group-schema'

type GroupJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: AgentJournalSnapshot['submissions']
}

/** Operations steered into an existing turn opened by another send, rather than opening their own. */
export function botGroupSteeredOperations(
  snapshot: GroupJournal,
  operationIds: readonly string[]
): ReadonlySet<string> {
  const anchors = structuredAgentTurnAnchors(snapshot.items, snapshot.submissions)
  const items = new Map(snapshot.items.map((item) => [item.itemId, item]))
  const steered = new Set<string>()
  for (const operationId of operationIds) {
    const submission = snapshot.submissions.findLast(
      (entry) => entry.clientMessageId === operationId || entry.queuedMessageId === operationId
    )
    if (submission?.answeredInTurn?.via === 'steer') {
      steered.add(operationId)
      continue
    }
    const keys = [
      agentJournalSubmissionKey(submission?.clientMessageId ?? operationId),
      submission?.providerItemId ?? ''
    ]
    const prompt = keys.map((key) => items.get(key)).find((item) => item !== undefined)
    if (
      prompt?.turnScope?.kind === 'turn' &&
      anchors.get(prompt.turnScope.turnItemId) !== prompt.itemId
    ) {
      steered.add(operationId)
    }
  }
  return steered
}

export type BotGroupSessionTurnSource = {
  groupTurnItems: (
    operationId: string,
    workerDispatchIds?: readonly string[]
  ) => readonly AgentJournalRenderItem[]
  steeredOperations?: ReadonlySet<string>
}

/** Whether a settled mail turn ended with only the quiet marker and left nothing else to draw. */
export function isQuietEmptyBotGroupMailTurn(
  turn: BotGroupTurn,
  items: readonly AgentJournalRenderItem[]
): boolean {
  if (!turn.mailbox || turn.error || turn.answer?.trim()) {
    return false
  }
  const canonical = items.find((item) => item.body.kind === 'turn')
  if (
    canonical?.body.kind !== 'turn' ||
    canonical.body.state !== 'completed' ||
    (canonical.body.outcome !== undefined && canonical.body.outcome !== 'success')
  ) {
    return false
  }
  let lastAssistantText: string | null = null
  for (const item of items) {
    if (item.agentId !== undefined) {
      return false
    }
    const { body } = item
    if (body.kind === 'turn') {
      continue
    }
    if (body.kind === 'message') {
      if (body.role === 'user') {
        continue
      }
      if (
        body.automationRun !== undefined ||
        (body.origin !== undefined && body.origin !== 'card-answer' && body.origin !== 'connector')
      ) {
        return false
      }
      if (
        body.blocks.some(
          (block) =>
            block.type === 'image-ref' ||
            block.type === 'subagent' ||
            block.type === 'subagent-group' ||
            block.type === 'background-task' ||
            (block.type === 'tool-call' &&
              block.state !== 'running' &&
              nativeChatRowRunsPullRequestCreate({
                id: item.itemId,
                role: body.role,
                blocks: [block],
                timestamp: item.observedAt,
                source: 'transcript'
              }))
        )
      ) {
        return false
      }
      if (body.role === 'assistant') {
        const text = body.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
        if (text.trim()) {
          lastAssistantText = text
        }
      }
      continue
    }
    if (body.kind === 'tool-call') {
      if (
        body.state !== 'running' &&
        nativeChatRowRunsPullRequestCreate({
          id: item.itemId,
          role: 'tool',
          blocks: [
            {
              type: 'tool-call',
              name: body.name,
              input: body.input,
              callId: body.callId,
              state: body.state
            }
          ],
          timestamp: item.observedAt,
          source: 'transcript'
        })
      ) {
        return false
      }
      continue
    }
    if (body.kind === 'diff') {
      return false
    }
    if (body.kind === 'approval' || body.kind === 'question' || body.kind === 'status') {
      continue
    }
    // Orca cards (agent-start, bot-item-note, etc.) remain visible in quiet turns.
    return false
  }
  return (
    lastAssistantText !== null &&
    isQuietBotResult(lastAssistantText) &&
    quietBotResultText(lastAssistantText) === ''
  )
}

/** Room messages with absorbed steered-mail duplicates and empty quiet mail turns omitted. */
export function visibleBotGroupMessages(
  messages: readonly BotGroupMessage[],
  sessions: ReadonlyMap<string, BotGroupSessionTurnSource>
): BotGroupMessage[] {
  const seenTurns = new Set<string>()
  const visible: BotGroupMessage[] = []
  for (const message of messages) {
    const turns = message.turns.filter((turn) => {
      const session = sessions.get(turn.sessionId)
      const items =
        turn.frozenItems ?? session?.groupTurnItems(turn.operationId, turn.workerDispatchIds) ?? []
      const canonical = items.find((item) => item.body.kind === 'turn')
      const turnKey = canonical ? `${turn.sessionId}\0${canonical.itemId}` : null
      const steered =
        !turn.frozenItems && session?.steeredOperations?.has(turn.operationId) === true
      if (!turn.answer?.trim() && (steered || (turnKey !== null && seenTurns.has(turnKey)))) {
        return false
      }
      if (turnKey !== null) {
        seenTurns.add(turnKey)
      }
      return !isQuietEmptyBotGroupMailTurn(turn, items)
    })
    if (message.author.kind === 'owner' || message.pausedAfter || turns.length > 0) {
      visible.push(turns.length === message.turns.length ? message : { ...message, turns })
    }
  }
  return visible
}
