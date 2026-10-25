import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from './native-chat-ask-types'
import { isInterruptedStatusMessage, type NativeChatMessage } from './native-chat-types'
import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput
} from './codex-async-question-input'

export type { AskOption, AskPrompt, AskQuestion, InteractiveQuestionParser }

const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

export { nativeChatAskDismissKey } from './native-chat-ask-dismiss-key'

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
  return scan.blocking ?? scan.replyAsMessage
}

/** A structured chat's pending question from its messages: blocking ones arrive as journal
 *  prompts, so only those answered by an ordinary message are left to read here. */
export function extractPendingMessageReplyAsk(
  messages: readonly NativeChatMessage[]
): AskPrompt | null {
  return scanPendingAsks(messages).replyAsMessage
}

/** A user row the agent received; a queued, unsent or withdrawn send answers nothing yet. */
function reachedAgent(message: NativeChatMessage): boolean {
  return (
    message.queued !== true &&
    message.unsent !== true &&
    message.stoppedBeforeStart !== true &&
    message.awaitsRetry !== true &&
    message.sentWhileStopping !== true
  )
}

function scanPendingAsks(messages: readonly NativeChatMessage[]): {
  blocking: AskPrompt | null
  replyAsMessage: AskPrompt | null
} {
  let pending: AskPrompt | null = null
  // Two counters track pending’s FIFO depth without retaining a queue entry per call.
  let outstanding = 0
  let pendingDepth = -1
  // Each async question stays open past its immediate result until the agent receives a message.
  let asyncQuestions: AskQuestion[] = []
  const asyncCallIds = new Set<string>()
  for (const message of messages) {
    // New user turns/interrupts abandon unresolved calls. Decoding drops tool_use_id, so orphan results cannot match by id;
    // reset the FIFO or one orphan strands later answered asks forever (#11761). Claude tool results decode as role tool.
    const interrupted = isInterruptedStatusMessage(message)
    if (message.role === 'user' || interrupted) {
      outstanding = 0
      pendingDepth = -1
      pending = null
      if (interrupted || reachedAgent(message)) {
        asyncQuestions = []
        asyncCallIds.clear()
      }
    }
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        const parsed = QUESTION_TOOL_PARSERS.has(block.name)
          ? parseAskFromToolInput(block.name, block.input)
          : parseToolInput(block.name, block.input)
        if (parsed?.replyAsMessage) {
          if (block.callId === undefined || !asyncCallIds.has(block.callId)) {
            asyncQuestions = [...asyncQuestions, ...parsed.questions]
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
  }
  return {
    blocking: pending,
    replyAsMessage:
      asyncQuestions.length > 0 ? { questions: asyncQuestions, replyAsMessage: true } : null
  }
}

/** Prefers live status and consults transcript history only after its read settles. */
export function resolveNativeChatAsk(args: {
  liveAsk: AskPrompt | null
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
}): AskPrompt | null {
  return args.liveAsk ?? (args.transcriptSettled ? extractPendingAsk(args.messages) : null)
}

export {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  type AskAnswerKeyGroup,
  type AskAnswerSelection
} from './native-chat-ask-answer'
