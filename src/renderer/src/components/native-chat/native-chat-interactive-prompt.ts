import { parseNativeChatApprovalEnvelope } from '../../../../shared/native-chat-approval-envelope'
import { translate } from '@/i18n/i18n'
import type {
  AgentJournalApprovalItem,
  AgentJournalApprovalSubject
} from '../../../../shared/agent-session-journal-types'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  parseAskFromStatus,
  registerQuestionTool,
  type AskAnswerKeyGroup,
  type AskAnswerSelection,
  type AskOption,
  type AskPrompt,
  type AskQuestion,
  type InteractiveQuestionParser
} from '../../../../shared/native-chat-ask'
import { parseOmpPlanReviewPrompt } from '../../../../shared/omp-plan-review-prompt'

export {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  parseAskFromStatus,
  registerQuestionTool,
  type AskAnswerKeyGroup,
  type AskAnswerSelection,
  type AskOption,
  type AskPrompt,
  type AskQuestion,
  type InteractiveQuestionParser
}

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

/** Desktop card for the shared approval envelope; question parsing stays cross-platform. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null,
  agent?: string
): ChatApproval | null {
  const planReview = parseOmpPlanReviewPrompt(interactivePrompt)
  if (planReview) {
    return {
      title: translate('components.native-chat.approval.plan.reviewTitle', 'Review proposed plan'),
      description: translate(
        'components.native-chat.approval.plan.refineHint',
        'Refine plan closes the review so you can send what to change.'
      ),
      subject: { kind: 'plan', text: planReview.plan },
      options: planReview.options
    }
  }
  const envelope = parseNativeChatApprovalEnvelope(interactivePrompt, agent)
  if (!envelope) {
    return null
  }
  return {
    title: translate('components.native-chat.approval.title', 'Allow {{value0}}?', {
      value0: envelope.tool
    }),
    detail: envelope.summary,
    options: [
      {
        label: translate('components.native-chat.approval.allow', 'Allow'),
        send: envelope.allowSend
      },
      { label: translate('components.native-chat.approval.deny', 'Deny'), send: envelope.denySend }
    ]
  }
}

export function parseInteractivePrompt(
  interactivePrompt: string | undefined | null,
  toolName?: string,
  agent?: string
): InteractivePromptCard {
  const prompt = parseAskFromStatus(interactivePrompt, toolName)
  if (prompt) {
    return { kind: 'question', prompt }
  }
  const approval = parseApprovalFromStatus(interactivePrompt, agent)
  return approval ? { kind: 'approval', approval } : null
}
