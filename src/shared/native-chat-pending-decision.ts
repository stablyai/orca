// The one pending-decision projection every client runs. Clients keep only
// presentation (labels, response encoding); which decision shows, and whether
// prose heuristics may run at all, is decided here.

import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from './agent-session-journal-types'
import { extractPendingAsk, type AskPrompt } from './native-chat-ask'
import {
  nativeChatAsyncQuestionsAllowHeuristics,
  type NativeChatAsyncQuestionsView
} from './native-chat-async-questions'
import {
  parseNativeChatDecisionEnvelope,
  readNativeChatApprovalSubject,
  type NativeChatDecisionEnvelope
} from './native-chat-decision-envelope'
import type { NativeChatMessage } from './native-chat-types'

export type NativeChatTerminalDecision =
  | Extract<NativeChatDecisionEnvelope, { kind: 'approval' }>
  | { kind: 'question'; prompt: AskPrompt }
  | Extract<NativeChatDecisionEnvelope, { kind: 'unsupported' }>

export type NativeChatTerminalDecisionResult = {
  decision: NativeChatTerminalDecision | null
  /** Ungated (status ask, else settled transcript ask): the dismissal identity. */
  detectedAsk: AskPrompt | null
  heuristicsAllowed: boolean
}

export type NativeChatDecisionStatus = {
  state?: string
  interactivePrompt?: string | null
  toolName?: string | null
}

/** STA-3144: an envelope outlives its answer, so only a waiting/blocked agent may show one. */
export function isNativeChatDecisionPaused(state: string | undefined): boolean {
  return state === 'waiting' || state === 'blocked'
}

export function resolveTerminalChatDecision(args: {
  status: NativeChatDecisionStatus | null | undefined
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
  asyncQuestions: NativeChatAsyncQuestionsView
}): NativeChatTerminalDecisionResult {
  const { status, messages, transcriptSettled, asyncQuestions } = args
  const paused = isNativeChatDecisionPaused(status?.state)
  const envelope = parseNativeChatDecisionEnvelope(
    status?.interactivePrompt,
    status?.toolName ?? undefined
  )
  const statusAsk = envelope.kind === 'question' ? envelope.prompt : null
  // A present status ask is the only question candidate, so the shown question and the
  // dismissal identity can never disagree.
  const transcriptAsk = statusAsk || !transcriptSettled ? null : extractPendingAsk(messages)
  const detectedAsk = statusAsk ?? transcriptAsk
  let decision: NativeChatTerminalDecision | null = null
  if (paused && (envelope.kind === 'approval' || envelope.kind === 'unsupported')) {
    decision = envelope
  } else {
    // The transcript ask clears itself when its result lands, so it needs no paused gate.
    const question = (paused ? statusAsk : null) ?? transcriptAsk
    decision = question ? { kind: 'question', prompt: question } : null
  }
  const heuristicsAllowed =
    paused &&
    envelope.kind === 'none' &&
    detectedAsk === null &&
    nativeChatAsyncQuestionsAllowHeuristics(asyncQuestions)
  return { decision, detectedAsk, heuristicsAllowed }
}

type StructuredPromptItem = AgentJournalRenderItem & {
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
}

export type NativeChatStructuredDecision<TItem extends StructuredPromptItem> =
  | { kind: 'approval'; item: TItem & { body: AgentJournalApprovalItem } }
  | { kind: 'question'; item: TItem & { body: AgentJournalQuestionItem } }
  | { kind: 'unsupported'; item: TItem; text?: string }

function isApprovalPrompt<TItem extends StructuredPromptItem>(
  item: TItem
): item is TItem & { body: AgentJournalApprovalItem } {
  return item.body.kind === 'approval'
}

function isQuestionPrompt<TItem extends StructuredPromptItem>(
  item: TItem
): item is TItem & { body: AgentJournalQuestionItem } {
  return item.body.kind === 'question'
}

/** The first pending prompt in journal order; an approval subject this build does not know
 *  is unsupported (shown, never approvable). */
export function resolveStructuredSessionDecision<TItem extends StructuredPromptItem>(
  pendingItems: readonly TItem[]
): NativeChatStructuredDecision<TItem> | null {
  const [item] = pendingItems
  if (!item) {
    return null
  }
  if (isApprovalPrompt(item)) {
    const subject: unknown = item.body.subject
    if (subject !== undefined && !readNativeChatApprovalSubject(subject)) {
      const text = item.body.title || item.body.detail || undefined
      return text ? { kind: 'unsupported', item, text } : { kind: 'unsupported', item }
    }
    return { kind: 'approval', item }
  }
  if (isQuestionPrompt(item)) {
    return { kind: 'question', item }
  }
  return null
}
