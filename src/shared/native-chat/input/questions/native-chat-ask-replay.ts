import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput
} from './codex-async-question-input'
import type { NativeChatMessage } from '../../native-chat-types'
import type { AsyncQuestionContributor, PendingAskScan } from '../native-chat-ask'
import { nativeChatAskScanOrder } from './native-chat-ask-order'
import { compareNativeChatTranscriptMessages } from '../../transcript/native-chat-transcript-projection'

export function asyncQuestionCallIds(message: NativeChatMessage): string[] {
  return message.blocks.flatMap((block) =>
    block.type === 'tool-call' &&
    block.name === CODEX_ASYNC_QUESTION_TOOL &&
    block.callId !== undefined &&
    parseCodexAsyncQuestionsInput(block.input)
      ? [block.callId]
      : []
  )
}

/** A replayed call keeps its earlier row's answer or dismissal; only its first row can open a question. */
export function firstAsyncQuestionCallRows(
  messages: readonly NativeChatMessage[]
): ReadonlySet<string> {
  const seen = new Set<string>()
  const first = new Set<string>()
  for (const message of messages) {
    for (const callId of asyncQuestionCallIds(message)) {
      if (!seen.has(callId)) {
        first.add(message.id)
      }
      seen.add(callId)
    }
  }
  return first
}

/** The same first-row reading over a tail window appended after earlier loaded rows. */
export function firstAsyncQuestionTailRows(
  earlier: readonly NativeChatMessage[],
  tail: readonly NativeChatMessage[]
): ReadonlySet<string> {
  return firstAsyncQuestionCallRows([
    ...earlier,
    ...[...nativeChatAskScanOrder(tail)].sort(compareNativeChatTranscriptMessages)
  ])
}

export function withoutReplayedAsyncQuestions(
  scan: PendingAskScan,
  first: ReadonlySet<string>
): PendingAskScan {
  return {
    ...scan,
    contributors: scan.contributors.filter((contributor) => first.has(contributor.sourceRowId))
  }
}

export function newestOpenAsyncQuestion(
  scan: PendingAskScan,
  first: ReadonlySet<string>
): AsyncQuestionContributor | undefined {
  return withoutReplayedAsyncQuestions(scan, first).contributors.at(-1)
}
