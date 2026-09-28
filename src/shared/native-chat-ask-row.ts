// The native-chat row that stands in for a question tool call. Both platform
// UIs read this copy (desktop as its i18n fallbacks, mobile directly) so the two
// can never describe the same pending question differently.

import { isAskUserQuestionTool } from './agent-question-answered-intent'
import { parseAskFromToolInput } from './native-chat-ask'
import {
  askPayloadQuestions,
  CODEX_ASK_TOOL_NAME,
  codexAskAnswers,
  NATIVE_CHAT_ANSWER_PART_SEPARATOR
} from './native-chat-ask-answers'
import {
  isToolCallBlock,
  type NativeChatBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from './native-chat-types'
import { pairToolBlocks } from './native-chat-tool-fold'

export const NATIVE_CHAT_ASK_ROW_COPY = {
  awaiting: 'Awaiting user input:',
  asked: 'Asked:',
  questionCount: '{{value0}} questions'
} as const

/** One question as the row shows it, with the reader's answer only where the agent
 *  recorded it as data. Prose results and secret questions carry none. */
export type NativeChatAskRowQuestion = {
  /** The agent's own id for the question, where it assigns one. */
  id?: string
  text: string
  answer?: string
}

/** What was asked: the one question, or every question of a grouped prompt. One
 *  row stands for the whole prompt, so a grouped prompt names its count on the
 *  line rather than quoting its first question as though it were the only one. */
export type NativeChatAskRowSubject =
  | ({ kind: 'question' } & NativeChatAskRowQuestion)
  | { kind: 'questions'; questions: NativeChatAskRowQuestion[] }

/** A question call paired with the result that answered it, if one has arrived. */
export type NativeChatAskRun = {
  call: NativeChatToolCallBlock
  result?: NativeChatToolResultBlock
}

/** Whether this block is a question tool call, and so is drawn as the awaiting
 *  row rather than as an ordinary tool line. */
export function isNativeChatAskCall(block: NativeChatBlock): boolean {
  return isToolCallBlock(block) && block.state !== 'failed' && isAskUserQuestionTool(block.name)
}

/** Remove each summarized call together with its FIFO result, preserving failed calls. */
export function nativeChatAskRunBlocks(blocks: NativeChatBlock[]): {
  asks: NativeChatAskRun[]
  unansweredAsks: NativeChatBlock[]
  work: NativeChatBlock[]
} {
  if (!blocks.some(isNativeChatAskCall)) {
    return { asks: [], unansweredAsks: [], work: blocks }
  }
  const removed = new Set<NativeChatBlock>()
  const asks: NativeChatAskRun[] = []
  const unansweredAsks: NativeChatBlock[] = []
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (!call || !isNativeChatAskCall(call) || result?.isError) {
      continue
    }
    asks.push(result ? { call, result } : { call })
    if (!result) {
      unansweredAsks.push(call)
    }
    removed.add(call)
    if (result) {
      removed.add(result)
    }
  }
  return {
    asks,
    unansweredAsks,
    work: removed.size ? blocks.filter((block) => !removed.has(block)) : blocks
  }
}

/** Whether this run asks the reader anything. Decided by the tool name alone,
 *  because that already says the agent is blocked on an answer — a payload this
 *  cannot parse must not put the raw call back on screen as the row it replaced. */
export function hasNativeChatAskCall(blocks: readonly NativeChatBlock[]): boolean {
  return blocks.some(isNativeChatAskCall)
}

/** Each question one call names, dropping any it states blankly, with the answer
 *  its result recorded as data. The call's tool name picks the reader: Codex's
 *  output is read by question id; any other agent's answers come only from the
 *  field its decoder filled, keyed by the question's exact text. */
function askCallQuestions({ call, result }: NativeChatAskRun): NativeChatAskRowQuestion[] {
  const prompt = parseAskFromToolInput(call.name, call.input)
  if (!prompt) {
    return []
  }
  // The card's prompt drops each question's id and secrecy, so they are read
  // from the raw payload, matched in order by the text the prompt kept.
  const raw = askPayloadQuestions(call.input)
  const isCodex = call.name === CODEX_ASK_TOOL_NAME
  const codexAnswers =
    result && isCodex
      ? codexAskAnswers(
          result.output,
          new Set(raw.flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : [])))
        )
      : null
  let cursor = 0
  const questions: NativeChatAskRowQuestion[] = []
  for (const { question } of prompt.questions) {
    const index = raw.findIndex((entry, at) => at >= cursor && entry.question === question)
    const source = index === -1 ? undefined : raw[index]
    cursor = index === -1 ? cursor : index + 1
    const text = question.trim()
    if (text.length === 0) {
      continue
    }
    const id = typeof source?.id === 'string' && source.id.length > 0 ? source.id : undefined
    const parts =
      source?.isSecret === true
        ? undefined
        : isCodex
          ? id === undefined
            ? undefined
            : codexAnswers?.get(id)
          : result?.askAnswers?.find((entry) => entry.question === question)?.answer
    questions.push({
      ...(id === undefined ? {} : { id }),
      text,
      ...(parts && parts.length > 0
        ? { answer: parts.join(NATIVE_CHAT_ANSWER_PART_SEPARATOR) }
        : {})
    })
  }
  return questions
}

/**
 * The subject for the whole run's question activity, or null when nothing in it
 * names a question — the row then stands on its label alone, which still tells
 * the reader the turn is theirs to unblock.
 *
 * Aggregated across calls, not taken from one: Codex journals a separate call
 * per question of the same prompt, so a per-call row would stack three pulsing
 * lines for what the reader was asked once.
 */
export function nativeChatAskRunSubject(
  asks: readonly NativeChatAskRun[]
): NativeChatAskRowSubject | null {
  const questions = asks.flatMap(askCallQuestions)
  if (questions.length === 0) {
    return null
  }
  if (questions.length > 1) {
    return { kind: 'questions', questions }
  }
  const only = questions[0]
  return only ? { kind: 'question', ...only } : null
}
