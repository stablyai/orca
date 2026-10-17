import { parseCodexAsyncQuestionReplyIds } from './codex-async-question-reply'
// Both transports use the same pending-question rules.

import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { compareAgentJournalItems } from './agent-session-journal-position'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import {
  readCodexAsyncQuestionCallArguments,
  readCodexAsyncQuestionList
} from './codex-async-question-item'
import {
  createNativeChatAsyncQuestionFoldState,
  foldNativeChatAsyncQuestionFact,
  nativeChatAsyncQuestionsFromFold,
  type NativeChatAsyncQuestion,
  type NativeChatAsyncQuestionFact
} from './native-chat-pending-async-questions'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

function askedFacts(
  blocks: readonly NativeChatBlock[],
  asker: 'root' | 'child',
  recordId: string,
  itemId: (providerItemId: string | undefined) => string | undefined
): NativeChatAsyncQuestionFact[] {
  return blocks.flatMap((block): NativeChatAsyncQuestionFact[] => {
    const questions =
      block.type === 'text' ? readCodexAsyncQuestionList(block.asyncQuestions) : null
    if (!questions) {
      return []
    }
    const providerItemId = block.type === 'text' ? block.asyncQuestionId : undefined
    const identity = itemId(providerItemId)
    return [
      {
        kind: 'asked',
        asker,
        recordId,
        ...(identity ? { itemId: identity } : {}),
        ...(providerItemId ? { providerItemId } : {}),
        questions
      }
    ]
  })
}

/** Async calls and asked questions in one decoded rollout message. A rollout is one agent's
 *  file, so every fact is root; the rollout's own call id is the item id (kept verbatim). */
export function nativeChatTranscriptAsyncQuestionFacts(
  message: NativeChatMessage
): NativeChatAsyncQuestionFact[] {
  if (message.role !== 'assistant') {
    return []
  }
  const calls = message.blocks.flatMap((block): NativeChatAsyncQuestionFact[] => {
    if (
      block.type !== 'tool-call' ||
      block.name.split('.').at(-1) !== 'request_user_input_async' ||
      !block.callId
    ) {
      return []
    }
    const questions = readCodexAsyncQuestionCallArguments(block.input)
    return questions ? [{ kind: 'async-call', callId: block.callId, questions }] : []
  })
  return [...calls, ...askedFacts(message.blocks, 'root', message.id, (id) => id)]
}

/** What the fold reads of a journal item. */
export type AsyncQuestionJournalItem = Pick<
  AgentJournalRenderItem,
  'itemId' | 'sequence' | 'sequenceIndex' | 'agentId' | 'body'
>

/** The submission behind a user item, by its journal key. */
export type AsyncQuestionSubmissionLookup = (itemId: string) => AgentJournalSubmission | undefined

function journalItemFacts(
  item: AsyncQuestionJournalItem,
  submissionFor: AsyncQuestionSubmissionLookup
): NativeChatAsyncQuestionFact[] {
  if (item.body.kind !== 'message') {
    return []
  }
  const author = isRootAgentJournalItem(item) ? 'root' : 'child'
  if (item.body.role === 'user') {
    const submission = submissionFor(item.itemId)
    // No submission backs it: the provider recorded it.
    if (submission !== undefined && submission.dispatchState !== 'accepted') {
      return []
    }
    if (author !== 'root') {
      return []
    }
    const text = item.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    const ids = parseCodexAsyncQuestionReplyIds(text)
    return [ids ? { kind: 'answered', ids } : { kind: 'delivered-user-message', author }]
  }
  if (item.body.role !== 'assistant') {
    return []
  }
  // The canonical journal item id survives resume; raw provider ids are renumbered.
  return askedFacts(item.body.blocks, author, item.itemId, () => item.itemId)
}

export function journalSubmissionLookup(
  submissions: readonly AgentJournalSubmission[]
): AsyncQuestionSubmissionLookup {
  const byKey = new Map(
    submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      submission
    ])
  )
  return (itemId) => byKey.get(itemId)
}

/** Facts of the journal in the reducer's order (a queued message sits at its handover). */
export function journalAsyncQuestionFacts(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): NativeChatAsyncQuestionFact[] {
  const submissionFor = journalSubmissionLookup(submissions)
  // Not `toSorted`: mobile's Hermes lacks it, and src/shared must stay loadable there.
  return Array.from(items)
    .sort(compareAgentJournalItems)
    .flatMap((item) => journalItemFacts(item, submissionFor))
}

export function deriveJournalAsyncQuestions(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): NativeChatAsyncQuestion[] {
  const state = createNativeChatAsyncQuestionFoldState()
  for (const fact of journalAsyncQuestionFacts(items, submissions)) {
    foldNativeChatAsyncQuestionFact(state, fact)
  }
  return nativeChatAsyncQuestionsFromFold(state)
}
