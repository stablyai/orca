import type {
  AgentJournalRenderItem,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session-journal-types'
import { isAskUserQuestionTool } from '../../../../shared/agent-question-answered-intent'
import { parseAskFromToolInput } from '../../../../shared/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { readAgentJournalTurn } from '../../../../shared/agent-session-turn-record'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'

type Projection = { message: NativeChatMessage | null; questionKey: string | null }
const projections = new WeakMap<AgentJournalRenderItem, Projection>()
const pendingGroups = new WeakMap<
  AgentJournalQuestionItem,
  {
    bodies: readonly AgentJournalQuestionItem[]
    body: AgentJournalQuestionItem
  }
>()

function pendingGroupBody(bodies: readonly AgentJournalQuestionItem[]): AgentJournalQuestionItem {
  const first = bodies[0]!
  if (bodies.length === 1) {
    return first
  }
  const cached = pendingGroups.get(first)
  if (
    cached?.bodies.length === bodies.length &&
    bodies.every((body, index) => body === cached.bodies[index])
  ) {
    return cached.body
  }
  const body: AgentJournalQuestionItem = {
    ...first,
    questions: bodies.flatMap((question, index) =>
      question.questions?.length
        ? question.questions
        : [
            {
              id: String(index),
              question: question.question,
              options: question.options,
              multiSelect: false
            }
          ]
    )
  }
  pendingGroups.set(first, { bodies, body })
  return body
}

function questionKey(questions: readonly { question: string }[]): string | null {
  const texts = questions.map(({ question }) => question.trim())
  return texts.length > 0 && texts.every(Boolean) ? JSON.stringify(texts.sort()) : null
}

function projectItem(item: AgentJournalRenderItem): Projection {
  const cached = projections.get(item)
  if (cached) {
    return cached
  }
  const { body } = item
  let message = projectStructuredItemToNativeChat(item)
  let key: string | null = null
  if (body.kind === 'question') {
    const questions = body.questions?.length ? body.questions : [{ question: body.question }]
    key = questionKey(questions)
    if (body.resolution.state === 'pending') {
      // A system row preserves question identity through tool folding; the receipt renders its body.
      message = {
        id: item.itemId,
        role: 'system',
        timestamp: item.observedAt,
        source: 'transcript',
        blocks: [{ type: 'text', text: body.question }]
      }
    }
  } else if (
    body.kind === 'tool-call' &&
    isAskUserQuestionTool(body.name) &&
    body.state !== 'failed'
  ) {
    const prompt = parseAskFromToolInput(body.name, body.input)
    key = prompt ? questionKey(prompt.questions) : null
  }
  const projection = { message, questionKey: key }
  projections.set(item, projection)
  return projection
}

/** Question presentation is client-local; archives and older RPC consumers keep their projection. */
function projectQuestions(items: readonly AgentJournalRenderItem[]): {
  messages: NativeChatMessage[]
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
} {
  // Consume one question item for each matching tool call. A Set would hide every
  // same-text call in a turn after the first question item, which can lose a real
  // duplicate call when only one prompt was journalled.
  const questionsByTurn = new Map<string, Map<string, number>>()
  const rows: { item: AgentJournalRenderItem; projection: Projection; turn: string }[] = []
  let turn = ''
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      turn = item.itemId
    }
    const lifecycle = readAgentJournalTurn(item.body)
    if (lifecycle) {
      turn = lifecycle.turnId
    }
    const projection = projectItem(item)
    rows.push({ item, projection, turn })
    if (turn && item.body.kind === 'question' && projection.questionKey) {
      let questions = questionsByTurn.get(turn)
      if (!questions) {
        questionsByTurn.set(turn, (questions = new Map()))
      }
      questions.set(projection.questionKey, (questions.get(projection.questionKey) ?? 0) + 1)
    }
  }
  const messages: NativeChatMessage[] = []
  const receipts = new Map<string, NativeChatResolvedPrompt>()
  let pendingGroup: { id: string; bodies: AgentJournalQuestionItem[] } | null = null
  const finishGroup = (): void => {
    if (!pendingGroup) {
      return
    }
    receipts.set(pendingGroup.id, pendingGroupBody(pendingGroup.bodies))
    pendingGroup = null
  }
  for (const { item, projection, turn: rowTurn } of rows) {
    if (
      item.body.kind === 'tool-call' &&
      projection.questionKey &&
      (questionsByTurn.get(rowTurn)?.get(projection.questionKey) ?? 0) > 0
    ) {
      const questions = questionsByTurn.get(rowTurn)!
      const remaining = questions.get(projection.questionKey)! - 1
      if (remaining === 0) {
        questions.delete(projection.questionKey)
      } else {
        questions.set(projection.questionKey, remaining)
      }
      continue
    }
    if (item.body.kind === 'question' && item.body.resolution.state === 'pending') {
      if (pendingGroup) {
        pendingGroup.bodies.push(item.body)
        continue
      }
      pendingGroup = { id: item.itemId, bodies: [item.body] }
    } else {
      finishGroup()
      if (
        (item.body.kind === 'question' || item.body.kind === 'approval') &&
        item.body.resolution.state !== 'pending'
      ) {
        receipts.set(item.itemId, item.body)
      }
    }
    if (projection.message) {
      messages.push(projection.message)
    }
  }
  finishGroup()
  return { messages, receipts }
}

const histories = new WeakMap<
  readonly AgentJournalRenderItem[],
  ReturnType<typeof projectQuestions>
>()

export function structuredQuestionTranscript(items: readonly AgentJournalRenderItem[]) {
  let projection = histories.get(items)
  if (!projection) {
    projection = projectQuestions(items)
    histories.set(items, projection)
  }
  return projection
}

export function projectStructuredQuestionMessages(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  return structuredQuestionTranscript(items).messages
}
