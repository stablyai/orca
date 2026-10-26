// Shared desktop i18n fallbacks and direct mobile copy keep pending-question rows consistent.

import { isAskUserQuestionTool } from './agent-question-answered-intent'
import { CODEX_ASYNC_QUESTION_TOOL } from './codex-async-question-input'
import { parseAskFromToolInput } from './native-chat-ask'
import { isToolCallBlock, type NativeChatBlock } from './native-chat-types'
import { pairToolBlocks } from './native-chat/tools/native-chat-tool-pairs'

export const NATIVE_CHAT_ASK_ROW_COPY = {
  awaiting: 'Awaiting user input:',
  awaitingUnnamed: 'Awaiting user input',
  asked: 'Asked:',
  questionCount: '{{value0}} questions'
} as const

/** One subject per whole prompt; grouped prompts show their count rather than only the first question. */
export type NativeChatAskRowSubject =
  | { kind: 'question'; text: string }
  | { kind: 'questions'; questions: string[] }

export function isNativeChatAskCall(block: NativeChatBlock): boolean {
  return (
    isToolCallBlock(block) &&
    block.state !== 'failed' &&
    (isAskUserQuestionTool(block.name) || block.name === CODEX_ASYNC_QUESTION_TOOL)
  )
}

/** Remove each summarized call together with its FIFO result, preserving failed calls. */
export function nativeChatAskRunBlocks(blocks: NativeChatBlock[]): {
  asks: NativeChatBlock[]
  unansweredAsks: NativeChatBlock[]
  work: NativeChatBlock[]
} {
  if (!blocks.some(isNativeChatAskCall)) {
    return { asks: [], unansweredAsks: [], work: blocks }
  }
  const removed = new Set<NativeChatBlock>()
  const asks: NativeChatBlock[] = []
  const unansweredAsks: NativeChatBlock[] = []
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (!call || !isNativeChatAskCall(call) || result?.isError) {
      continue
    }
    asks.push(call)
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

/** Tool identity alone signals a pending question; unreadable input must not restore the raw tool row. */
export function hasNativeChatAskCall(blocks: readonly NativeChatBlock[]): boolean {
  return blocks.some(isNativeChatAskCall)
}

function askCallQuestions(block: NativeChatBlock): string[] {
  if (!isToolCallBlock(block)) {
    return []
  }
  const prompt = parseAskFromToolInput(block.name, block.input)
  return prompt
    ? prompt.questions.map((question) => question.question.trim()).filter((text) => text.length > 0)
    : []
}

/** Aggregate question activity across calls (Codex emits one per question). Null means use the row label alone. */
export function nativeChatAskRunSubject(
  blocks: readonly NativeChatBlock[]
): NativeChatAskRowSubject | null {
  const questions = blocks.filter(isNativeChatAskCall).flatMap(askCallQuestions)
  if (questions.length === 0) {
    return null
  }
  if (questions.length > 1) {
    return { kind: 'questions', questions }
  }
  const text = questions[0]
  return text ? { kind: 'question', text } : null
}
