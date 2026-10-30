import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from './native-chat-ask-types'
import { isInterruptedStatusMessage, type NativeChatMessage } from '../../native-chat-types'
import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput
} from '../../codex-async-question-input'

const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

export function registerQuestionTool(toolName: string, parser: InteractiveQuestionParser): void {
  QUESTION_TOOL_PARSERS.set(toolName, parser)
}

function parseCanonicalQuestionsInput(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object' || !('questions' in input)) {
    return null
  }
  const rawQuestions = input.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const text = 'question' in raw && typeof raw.question === 'string' ? raw.question : ''
    const rawOptions = 'options' in raw ? raw.options : undefined
    const options = parseOptions(rawOptions)
    if (text || options.length > 0) {
      const multiSelect =
        'multiSelect' in raw
          ? raw.multiSelect === true
          : ('multiple' in raw && raw.multiple === true) || ('multi' in raw && raw.multi === true)
      questions.push({
        question: text,
        header: 'header' in raw && typeof raw.header === 'string' ? raw.header : undefined,
        multiSelect,
        options,
        ...(!multiSelect && askOptionsHavePreview(rawOptions) ? { hasPreviews: true } : {})
      })
    }
  }
  return questions.length > 0 ? { questions } : null
}

/** Claude only switches a single-select to its preview layout for a non-blank preview. */
export function askOptionsHavePreview(rawOptions: unknown): boolean {
  return (
    Array.isArray(rawOptions) &&
    rawOptions.some(
      (option) =>
        option &&
        typeof option === 'object' &&
        'preview' in option &&
        typeof option.preview === 'string' &&
        option.preview.trim().length > 0
    )
  )
}

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((option): AskOption | null => {
      if (typeof option === 'string') {
        return { label: option }
      }
      if (
        option &&
        typeof option === 'object' &&
        'label' in option &&
        typeof option.label === 'string'
      ) {
        return {
          label: option.label,
          description:
            'description' in option && typeof option.description === 'string'
              ? option.description
              : undefined
        }
      }
      return null
    })
    .filter((option): option is AskOption => option !== null)
}

for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion']) {
  QUESTION_TOOL_PARSERS.set(name, parseCanonicalQuestionsInput)
}

QUESTION_TOOL_PARSERS.set(CODEX_ASYNC_QUESTION_TOOL, parseCodexAsyncQuestionsInput)

function parseToolInput(toolName: string | undefined, input: unknown): AskPrompt | null {
  const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined
  return (parser ? parser(input) : null) ?? parseCanonicalQuestionsInput(input)
}

export function parseAskFromStatus(
  interactivePrompt: string | undefined | null,
  toolName?: string
): AskPrompt | null {
  if (!interactivePrompt) {
    return null
  }
  try {
    return parseToolInput(toolName, JSON.parse(interactivePrompt))
  } catch {
    return null
  }
}

/** Use live status’s registered-parser dispatch on tool input; decode Codex’s JSON-string arguments first. */
export function parseAskFromToolInput(
  toolName: string | undefined,
  input: unknown
): AskPrompt | null {
  return typeof input === 'string'
    ? parseAskFromStatus(input, toolName)
    : parseToolInput(toolName, input)
}

/** Newest question lacking its FIFO result; share live registered-parser/canonical-shape fallback so reconnects cannot drop visible asks. */
export function extractPendingAsk(messages: readonly NativeChatMessage[]): AskPrompt | null {
  const scan = scanPendingAsks(messages)
  return scan.blocking ?? aggregateAsyncQuestions(scan.contributors)
}

/** A structured chat's pending question from its messages: blocking ones arrive as journal
 *  prompts, so only those answered by an ordinary message are left to read here. */
export function extractPendingMessageReplyAsk(
  messages: readonly NativeChatMessage[]
): AskPrompt | null {
  return aggregateAsyncQuestions(scanPendingAsks(messages).contributors)
}

/** Delivered human input only; agent notices and pending sends answer no async question. */
export function isDeliveredNativeChatUserMessage(message: NativeChatMessage): boolean {
  return (
    message.role === 'user' &&
    message.from?.kind !== 'agent' &&
    message.queued !== true &&
    message.unsent !== true &&
    message.stoppedBeforeStart !== true &&
    message.awaitsRetry !== true &&
    message.sentWhileStopping !== true
  )
}

export type AsyncQuestionContributor = {
  sourceRowId: string
  /** Parsed async-call slot before dedupe, independent of unrelated blocks and question text. */
  callSlot: number
  timestamp: number | null
  questions: AskQuestion[]
  responseMode: 'message'
}

export type AsyncQuestionSourceScope =
  | { kind: 'journal'; agent: string | null; sessionId: string | null; epoch: string | null }
  | {
      kind: 'transcript'
      agent: string | null
      sessionId: string | null
      transcriptPath: string | null
    }

/** Shared source fields only; host/view routing still owns each local dismissal cache. */
export function asyncQuestionSourceScope(source: AsyncQuestionSourceScope): string {
  return source.kind === 'journal'
    ? JSON.stringify(['journal', source.agent, source.sessionId, source.epoch])
    : JSON.stringify(['transcript', source.agent, source.sessionId, source.transcriptPath])
}

// Canonical rows survive provider renumbering; definition edits do not create a new occurrence.
export function asyncQuestionOccurrenceId(
  sourceScope: string,
  contributor: AsyncQuestionContributor
): string {
  return JSON.stringify([
    'async-question',
    sourceScope,
    contributor.sourceRowId,
    contributor.callSlot
  ])
}

/** Filter addressed calls before grouping; one call's complete definition stays together. */
export function aggregateAsyncQuestions(
  contributors: readonly AsyncQuestionContributor[],
  sourceScope?: string,
  hiddenIds?: ReadonlySet<string>
): AskPrompt | null {
  const questions: AskQuestion[] = []
  const occurrenceIds: string[] = []
  for (const contributor of contributors) {
    const id =
      sourceScope === undefined ? undefined : asyncQuestionOccurrenceId(sourceScope, contributor)
    if (id !== undefined && hiddenIds?.has(id)) {
      continue
    }
    if (id !== undefined) {
      occurrenceIds.push(id)
    }
    for (const question of contributor.questions) {
      questions.push(question)
    }
  }
  return questions.length > 0
    ? { questions, replyAsMessage: true, ...(sourceScope === undefined ? {} : { occurrenceIds }) }
    : null
}

export type PendingAskScan = {
  blocking: AskPrompt | null
  contributors: AsyncQuestionContributor[]
}

export function scanPendingAsks(messages: readonly NativeChatMessage[]): PendingAskScan {
  const scanner = createPendingAskScanner()
  for (const message of messages) {
    scanner.append(message)
  }
  return scanner.current()
}

/** One source pass; current borrows the pending array without copying definitions on every append. */
export function createPendingAskScanner(): {
  append: (message: NativeChatMessage) => readonly AsyncQuestionContributor[]
  current: () => PendingAskScan
  interrupt: () => void
} {
  let pending: AskPrompt | null = null
  // Two counters track pending’s FIFO depth without retaining a queue entry per call.
  let outstanding = 0
  let pendingDepth = -1
  // Async questions await the person's message, not an orchestration notice from another agent.
  let contributors: AsyncQuestionContributor[] = []
  const asyncSlots = new Map<string, number>()
  const asyncCallIds = new Set<string>()
  const resetBlocking = (): void => {
    outstanding = 0
    pendingDepth = -1
    pending = null
  }
  const interrupt = (): void => {
    resetBlocking()
    contributors = []
    asyncCallIds.clear()
  }
  const append = (message: NativeChatMessage): readonly AsyncQuestionContributor[] => {
    const accepted: AsyncQuestionContributor[] = []
    // New user turns/interrupts abandon unresolved calls. Decoding drops tool_use_id, so orphan results cannot match by id;
    // reset the FIFO or one orphan strands later answered asks forever (#11761). Claude tool results decode as role tool.
    const interrupted = isInterruptedStatusMessage(message)
    if (message.role === 'user' || interrupted) {
      if (interrupted || isDeliveredNativeChatUserMessage(message)) {
        interrupt()
      } else {
        resetBlocking()
      }
    }
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        const parsed = QUESTION_TOOL_PARSERS.has(block.name)
          ? parseAskFromToolInput(block.name, block.input)
          : parseToolInput(block.name, block.input)
        if (parsed?.replyAsMessage) {
          // A duplicate outside the loaded window must not renumber this row's surviving siblings.
          const callSlot = asyncSlots.get(message.id) ?? 0
          asyncSlots.set(message.id, callSlot + 1)
          if (block.callId === undefined || !asyncCallIds.has(block.callId)) {
            const contributor: AsyncQuestionContributor = {
              sourceRowId: message.id,
              callSlot,
              timestamp: message.timestamp,
              questions: parsed.questions,
              responseMode: 'message'
            }
            contributors.push(contributor)
            accepted.push(contributor)
          }
          if (block.callId !== undefined) {
            asyncCallIds.add(block.callId)
          }
        } else if (parsed) {
          pending = parsed
          pendingDepth = outstanding
        }
        outstanding += 1
      } else if (block.type === 'tool-result' && outstanding > 0) {
        outstanding -= 1
        if (pendingDepth === 0) {
          pending = null
          pendingDepth = -1
        } else if (pendingDepth > 0) {
          pendingDepth -= 1
        }
      }
    }
    return accepted
  }
  return { append, interrupt, current: () => ({ blocking: pending, contributors }) }
}

/** Prefers live status and consults transcript history only after its read settles. */
export function resolveNativeChatAsk(args: {
  liveAsk: AskPrompt | null
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
  transcriptAsk?: AskPrompt | null
}): AskPrompt | null {
  return (
    args.liveAsk ??
    (args.transcriptSettled
      ? args.transcriptAsk === undefined
        ? extractPendingAsk(args.messages)
        : args.transcriptAsk
      : null)
  )
}
