import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from './native-chat-ask-types'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

export type { AskOption, AskPrompt, AskQuestion, InteractiveQuestionParser }

const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

export function registerQuestionTool(toolName: string, parser: InteractiveQuestionParser): void {
  QUESTION_TOOL_PARSERS.set(toolName, parser)
}

function parseQuestionsShape(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const rawQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const question = raw as Record<string, unknown>
    const text = typeof question.question === 'string' ? question.question : ''
    const options = parseOptions(question.options)
    if (text || options.length > 0) {
      questions.push({
        question: text,
        header: typeof question.header === 'string' ? question.header : undefined,
        multiSelect: question.multiSelect === true,
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
        typeof (option as { label?: unknown }).label === 'string'
      ) {
        const value = option as { label: string; description?: unknown }
        return {
          label: value.label,
          description: typeof value.description === 'string' ? value.description : undefined
        }
      }
      return null
    })
    .filter((option): option is AskOption => option !== null)
}

for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion']) {
  QUESTION_TOOL_PARSERS.set(name, parseQuestionsShape)
}

function parseToolInput(toolName: string | undefined, input: unknown): AskPrompt | null {
  const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined
  return (parser ? parser(input) : null) ?? parseQuestionsShape(input)
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

function questionToolFor(block: NativeChatBlock): InteractiveQuestionParser | null {
  return block.type === 'tool-call' ? (QUESTION_TOOL_PARSERS.get(block.name) ?? null) : null
}

/** Resolve the newest question tool that has not received its FIFO tool result. */
export function extractPendingAsk(messages: readonly NativeChatMessage[]): AskPrompt | null {
  let pending: AskPrompt | null = null
  const outstanding: (AskPrompt | null)[] = []
  for (const message of messages) {
    for (const block of message.blocks) {
      const parser = questionToolFor(block)
      if (block.type === 'tool-call') {
        const parsed = parser ? parser(block.input) : null
        if (parsed) {
          pending = parsed
        }
        outstanding.push(parsed)
      } else if (block.type === 'tool-result' && outstanding.length > 0) {
        const resolved = outstanding.shift()
        if (resolved && resolved === pending) {
          pending = null
        }
      }
    }
  }
  return pending
}

export function formatAskAnswer(prompt: AskPrompt, selections: readonly string[][]): string {
  return prompt.questions.map((_, index) => (selections[index] ?? []).join(', ')).join('\n')
}

export function formatCompleteAskAnswer(answers: readonly string[]): string | null {
  const normalized = answers.map((answer) => answer.trim())
  return normalized.length > 0 && normalized.every((answer) => answer.length > 0)
    ? normalized.join('\n')
    : null
}
