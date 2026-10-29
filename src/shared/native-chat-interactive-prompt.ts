import { parseNativeChatApprovalEnvelope } from './native-chat-approval-envelope'
import type {
  AgentJournalApprovalItem,
  AgentJournalApprovalSubject
} from './agent-session-journal-types'
import { parseAskFromStatus, resolveNativeChatAsk } from './native-chat/input/native-chat-ask'
import type { AskPrompt } from './native-chat/input/native-chat-ask-types'
import type { NativeChatMessage } from './native-chat-types'
import { parseOmpPlanReviewPrompt } from './omp-plan-review-prompt'

export type ChatApproval = {
  title: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  subject?: AgentJournalApprovalSubject
  detail?: string
  options: { label: string; send: string }[]
}

/** A journal approval prompt as its card reads it; each option sends its id. */
export function chatApprovalFromJournal(body: AgentJournalApprovalItem): ChatApproval {
  return {
    title: body.title,
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.decisionReason ? { decisionReason: body.decisionReason } : {}),
    ...(body.blockedPath ? { blockedPath: body.blockedPath } : {}),
    ...(body.subject ? { subject: body.subject } : {}),
    ...(body.detail ? { detail: body.detail } : {}),
    options: body.options.map((option) => ({ label: option.label, send: option.id }))
  }
}

export type InteractivePromptCard =
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; approval: ChatApproval }
  | null

/** English approval-card copy; desktop's translations fall back to it. */
export const NATIVE_CHAT_APPROVAL_COPY = {
  title: 'Allow {{value0}}?',
  allow: 'Allow',
  deny: 'Deny',
  planReviewTitle: 'Review proposed plan',
  planRefineHint: 'Refine plan closes the review so you can send what to change.'
} as const

export type NativeChatApprovalSay = (
  id: keyof typeof NATIVE_CHAT_APPROVAL_COPY,
  values?: { value0: string }
) => string

const sayNativeChatApprovalEnglish: NativeChatApprovalSay = (id, values) =>
  values
    ? NATIVE_CHAT_APPROVAL_COPY[id].replace('{{value0}}', values.value0)
    : NATIVE_CHAT_APPROVAL_COPY[id]

/** The card for the agent's approval envelope (OMP plan review included); never read from prose. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null,
  agent?: string,
  say: NativeChatApprovalSay = sayNativeChatApprovalEnglish
): ChatApproval | null {
  const planReview = parseOmpPlanReviewPrompt(interactivePrompt)
  if (planReview) {
    return {
      title: say('planReviewTitle'),
      description: say('planRefineHint'),
      subject: { kind: 'plan', text: planReview.plan },
      options: planReview.options
    }
  }
  const envelope = parseNativeChatApprovalEnvelope(interactivePrompt, agent)
  if (!envelope) {
    return null
  }
  return {
    title: say('title', { value0: envelope.tool }),
    detail: envelope.summary,
    options: [
      { label: say('allow'), send: envelope.allowSend },
      { label: say('deny'), send: envelope.denySend }
    ]
  }
}

export function parseInteractivePrompt(
  interactivePrompt: string | undefined | null,
  toolName?: string,
  agent?: string,
  say?: NativeChatApprovalSay
): InteractivePromptCard {
  const prompt = parseAskFromStatus(interactivePrompt, toolName)
  if (prompt) {
    return { kind: 'question', prompt }
  }
  const approval = parseApprovalFromStatus(interactivePrompt, agent, say)
  return approval ? { kind: 'approval', approval } : null
}

/** A live approval wins, then the live or unresolved transcript ask, so a parked selector cannot consume the next message as its answer. */
export function resolveNativeChatInteractivePromptCard(args: {
  interactivePrompt: string | undefined | null
  toolName?: string
  agent?: string
  /** Pass the command-boundary-trimmed messages so an ask abandoned via `/clear` stays gone. */
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
  say?: NativeChatApprovalSay
}): InteractivePromptCard {
  const statusCard = parseInteractivePrompt(
    args.interactivePrompt,
    args.toolName,
    args.agent,
    args.say
  )
  if (statusCard?.kind === 'approval') {
    return statusCard
  }
  const prompt = resolveNativeChatAsk({
    liveAsk: statusCard?.prompt ?? null,
    messages: args.messages,
    transcriptSettled: args.transcriptSettled
  })
  return prompt ? { kind: 'question', prompt } : null
}
