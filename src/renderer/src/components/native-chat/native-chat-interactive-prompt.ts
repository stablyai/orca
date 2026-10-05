import { nativeChatApprovalAcceptKey } from '../../../../shared/native-chat-agent-support'
import { translate } from '@/i18n/i18n'
import type {
  AgentJournalApprovalMatchedAskRule,
  AgentJournalApprovalSubject
} from '../../../../shared/agent-session-journal-types'
import { parseNativeChatDecisionEnvelope } from '../../../../shared/native-chat-decision-envelope'
import type { NativeChatTerminalDecision } from '../../../../shared/native-chat-pending-decision'
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
  matchedAskRule?: AgentJournalApprovalMatchedAskRule
  subject?: AgentJournalApprovalSubject
  detail?: string
  options: { label: string; send: string }[]
}

export type InteractivePromptCard =
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; approval: ChatApproval }
  | { kind: 'unsupported'; approval: ChatApproval }
  | null

const ESCAPE = String.fromCharCode(27)

/** Shown, never approvable: the request's own words and one line, with no options. */
export function unsupportedChatApproval(text: string | undefined): ChatApproval {
  const line = translate(
    'components.native-chat.decision.unsupported',
    'This request needs a newer version of Orca.'
  )
  return text ? { title: text, description: line, options: [] } : { title: line, options: [] }
}

/** Labels for an approval decision; the parse lives in the shared envelope reader. */
export function chatApprovalFromDecision(
  decision: { tool: string; summary?: string; subject?: AgentJournalApprovalSubject },
  agent?: string
): ChatApproval {
  return {
    title: translate('components.native-chat.approval.title', 'Allow {{value0}}?', {
      value0: decision.tool
    }),
    ...(decision.summary ? { detail: decision.summary } : {}),
    ...(decision.subject ? { subject: decision.subject } : {}),
    options: [
      {
        label: translate('components.native-chat.approval.allow', 'Allow'),
        send: nativeChatApprovalAcceptKey(agent)
      },
      { label: translate('components.native-chat.approval.deny', 'Deny'), send: ESCAPE }
    ]
  }
}

export function interactivePromptCardFromDecision(
  decision: NativeChatTerminalDecision | null,
  agent?: string
): InteractivePromptCard {
  if (!decision) {
    return null
  }
  if (decision.kind === 'question') {
    return { kind: 'question', prompt: decision.prompt }
  }
  if (decision.kind === 'approval') {
    return { kind: 'approval', approval: chatApprovalFromDecision(decision, agent) }
  }
  return { kind: 'unsupported', approval: unsupportedChatApproval(decision.text) }
}

/** The approval card for an envelope that is an approval, else null. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null,
  agent?: string
): ChatApproval | null {
  const envelope = parseNativeChatDecisionEnvelope(interactivePrompt)
  return envelope.kind === 'approval' ? chatApprovalFromDecision(envelope, agent) : null
}

/** The card an envelope alone describes, ungated (callers apply the paused gate). */
export function parseInteractivePrompt(
  interactivePrompt: string | undefined | null,
  toolName?: string,
  agent?: string
): InteractivePromptCard {
  const envelope = parseNativeChatDecisionEnvelope(interactivePrompt, toolName)
  return envelope.kind === 'none' ? null : interactivePromptCardFromDecision(envelope, agent)
}
