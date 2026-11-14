import type {
  AgentJournalRenderItem,
  AgentJournalQuestionItem
} from './agent-session/journal/agent-session-journal-types'
import { isAskUserQuestionTool } from './agent-status/lifecycle/agent-question-answered-intent'
import { parseAskFromToolInput } from './native-chat/input/native-chat-ask'
import { agentJournalItemRowOrigin } from './agent-session/journal/agent-session-journal-position'
import { agentJournalLinkageFields } from './agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat/native-chat-types'
import { projectStructuredItemToNativeChat } from './agent-session/view/structured-agent-session-projection'
import { readAgentJournalTurn } from './agent-session/lifecycle/records/agent-session-turn-record'
import type { NativeChatResolvedPrompt } from './native-chat/native-chat-resolution-receipt'

type Projection = { message: NativeChatMessage | null; questionKey: string | null }
type ItemProjector = (item: AgentJournalRenderItem) => NativeChatMessage | null
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

function projectItem(
  item: AgentJournalRenderItem,
  projections: WeakMap<AgentJournalRenderItem, Projection>,
  projectMessage: ItemProjector
): Projection {
  const cached = projections.get(item)
  if (cached) {
    return cached
  }
  const { body } = item
  let message = projectMessage(item)
  let key: string | null = null
  if (body.kind === 'question') {
    const questions = body.questions?.length ? body.questions : [{ question: body.question }]
    key = questionKey(questions)
    if (body.resolution.state === 'pending') {
      // A system row preserves question identity through tool folding; the receipt renders its body.
      message = {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: 'system',
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
function projectQuestions(
  items: readonly AgentJournalRenderItem[],
  project: (item: AgentJournalRenderItem) => Projection
): {
  messages: NativeChatMessage[]
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
} {
  // Count matching question items; a Set would hide extra same-text tool calls that were never journalled as prompts.
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
    const projection = project(item)
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

/** Whether revising or appending this item leaves every other row's question grouping and receipts as they were. */
export function isQuestionNeutralAgentJournalItem(item: AgentJournalRenderItem): boolean {
  const { body } = item
  return (
    body.kind !== 'question' &&
    body.kind !== 'approval' &&
    !(body.kind === 'tool-call' && isAskUserQuestionTool(body.name))
  )
}

/** Both revisions delimit question turns alike: a user row by its id, a turn record by its turnId. */
export function sameQuestionTurnBoundary(
  before: AgentJournalRenderItem,
  after: AgentJournalRenderItem
): boolean {
  return (
    before.itemId === after.itemId &&
    before.body.kind === after.body.kind &&
    (before.body.kind !== 'message' ||
      (after.body.kind === 'message' && before.body.role === after.body.role)) &&
    readAgentJournalTurn(before.body)?.turnId === readAgentJournalTurn(after.body)?.turnId
  )
}

type QuestionTranscript = ReturnType<typeof projectQuestions>
type QuestionStreamState = {
  items: readonly AgentJournalRenderItem[]
  projection: QuestionTranscript
  /** Each item's row in `projection.messages`, or -1 when it draws none. */
  rowOf: number[]
}

function questionRowIndexes(
  items: readonly AgentJournalRenderItem[],
  messages: readonly NativeChatMessage[],
  project: (item: AgentJournalRenderItem) => Projection
): number[] {
  let next = 0
  return items.map((item) => {
    const message = project(item).message
    return message !== null && messages[next] === message ? next++ : -1
  })
}

function reuseQuestions(
  previous: QuestionStreamState,
  items: readonly AgentJournalRenderItem[],
  project: (item: AgentJournalRenderItem) => Projection
): QuestionStreamState | null {
  if (items.length < previous.items.length) {
    return null
  }
  let messages: NativeChatMessage[] | null = null
  for (let index = 0; index < previous.items.length; index += 1) {
    const before = previous.items[index]!
    const item = items[index]!
    if (before === item) {
      continue
    }
    if (
      !isQuestionNeutralAgentJournalItem(before) ||
      !isQuestionNeutralAgentJournalItem(item) ||
      !sameQuestionTurnBoundary(before, item)
    ) {
      return null
    }
    const old = project(before).message
    const next = project(item).message
    const row = previous.rowOf[index]!
    if ((old === null) !== (next === null) || (old && previous.projection.messages[row] !== old)) {
      return null
    }
    if (next) {
      ;(messages ??= previous.projection.messages.slice())[row] = next
    }
  }
  let rowOf = previous.rowOf
  for (let index = previous.items.length; index < items.length; index += 1) {
    const item = items[index]!
    if (!isQuestionNeutralAgentJournalItem(item)) {
      return null
    }
    const message = project(item).message
    messages ??= previous.projection.messages.slice()
    rowOf = rowOf === previous.rowOf ? rowOf.slice() : rowOf
    rowOf.push(message ? messages.push(message) - 1 : -1)
  }
  return {
    items,
    projection: messages
      ? { messages, receipts: previous.projection.receipts }
      : previous.projection,
    rowOf
  }
}

/** Each surface owns caches for the item interpretation it renders. */
export function createStructuredQuestionProjection(
  projectMessage: ItemProjector = projectStructuredItemToNativeChat
) {
  const projections = new WeakMap<AgentJournalRenderItem, Projection>()
  const histories = new WeakMap<
    readonly AgentJournalRenderItem[],
    ReturnType<typeof projectQuestions>
  >()
  const project = (item: AgentJournalRenderItem) => projectItem(item, projections, projectMessage)
  const transcript = (items: readonly AgentJournalRenderItem[]) => {
    let projection = histories.get(items)
    if (!projection) {
      projection = projectQuestions(items, project)
      histories.set(items, projection)
    }
    return projection
  }
  /** One consumer's transcript across commits: question-neutral revisions and appends reuse its rows and receipts. */
  const stream = () => {
    let previous: QuestionStreamState | null = null
    return (items: readonly AgentJournalRenderItem[]): QuestionTranscript => {
      if (previous?.items === items) {
        return previous.projection
      }
      const reused = previous && reuseQuestions(previous, items, project)
      if (reused) {
        previous = reused
      } else {
        const projection = transcript(items)
        previous = {
          items,
          projection,
          rowOf: questionRowIndexes(items, projection.messages, project)
        }
      }
      return previous.projection
    }
  }
  return {
    transcript,
    stream,
    messages: (items: readonly AgentJournalRenderItem[]) => transcript(items).messages
  }
}

export const {
  transcript: structuredQuestionTranscript,
  messages: projectStructuredQuestionMessages
} = createStructuredQuestionProjection()
