import { nativeChatApprovalAcceptKey } from '../../../../shared/native-chat-agent-support'
import { translate } from '@/i18n/i18n'
import type {
  AgentJournalApprovalItem,
  AgentJournalApprovalMatchedAskRule,
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

/** A journal approval prompt as its card reads it; each option sends its id. */
export function chatApprovalFromJournal(body: AgentJournalApprovalItem): ChatApproval {
  return {
    title: body.title,
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.decisionReason ? { decisionReason: body.decisionReason } : {}),
    ...(body.blockedPath ? { blockedPath: body.blockedPath } : {}),
    ...(body.matchedAskRule ? { matchedAskRule: body.matchedAskRule } : {}),
    ...(body.subject ? { subject: body.subject } : {}),
    ...(body.detail ? { detail: body.detail } : {}),
    options: body.options.map((option) => ({ label: option.label, send: option.id }))
  }
}

export type InteractivePromptCard =
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; approval: ChatApproval }
  | null

const ESCAPE = String.fromCharCode(27)

/** Parse the desktop-only approval envelope; question parsing stays cross-platform. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null,
  agent?: string
): ChatApproval | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const approval = (parsed as { approval?: unknown }).approval
  if (!approval || typeof approval !== 'object') {
    return null
  }
  const tool = (approval as { tool?: unknown }).tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  const summary = (approval as { summary?: unknown }).summary
  return {
    title: translate('components.native-chat.approval.title', 'Allow {{value0}}?', {
      value0: tool
    }),
    detail: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
    options: [
      {
        label: translate('components.native-chat.approval.allow', 'Allow'),
        send: nativeChatApprovalAcceptKey(agent)
      },
      { label: translate('components.native-chat.approval.deny', 'Deny'), send: ESCAPE }
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
