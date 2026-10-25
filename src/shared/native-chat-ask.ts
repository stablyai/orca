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
    const options = parseOptions('options' in raw ? raw.options : undefined)
    if (text || options.length > 0) {
      questions.push({
        question: text,
        header: 'header' in raw && typeof raw.header === 'string' ? raw.header : undefined,
        multiSelect:
          'multiSelect' in raw
            ? raw.multiSelect === true
            : ('multiple' in raw && raw.multiple === true) ||
              ('multi' in raw && raw.multi === true),
        options
      })
    }
  }
  return questions.length > 0 ? { questions } : null
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

/** Parse a question tool call's own input, through the same registered-parser
 *  dispatch live status uses. Codex delivers arguments as a JSON string, so a
 *  string input is decoded rather than treated as prose. */
export function parseAskFromToolInput(
  toolName: string | undefined,
  input: unknown
): AskPrompt | null {
  return typeof input === 'string'
    ? parseAskFromStatus(input, toolName)
    : parseToolInput(toolName, input)
}

/** Resolve the newest question tool that has not received its FIFO tool result.
 *  Transcript replay parses each tool-call through the same registered-parser +
 *  canonical-shape fallback as live status, so a question tool that rendered
 *  live cannot vanish from pending state after a reconnect/replay. */
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
  // The FIFO is two counters, not a queue: a result only needs to know how far the
  // call that produced `pending` sits from the head, so nothing is retained per call.
  let outstanding = 0
  let pendingDepth = -1
  // Each async question stays open past its immediate result until the agent receives a message.
  let asyncQuestions: AskQuestion[] = []
  const asyncCallIds = new Set<string>()
  for (const message of messages) {
    // A new user turn (or an interrupt row) ends the turn that owns whatever
    // calls are still in flight: their results never arrive, and `tool_use_id`
    // is dropped at decode time so those orphans can never be matched by id.
    // Without this reset one orphan shifts the result FIFO for the rest of the
    // transcript and strands an answered ask as a permanent card over the
    // composer (#11761). Claude's tool-result turns decode as role 'tool'.
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
