import type { AgentJournalApprovalItem } from '../../../../shared/agent-session-journal-types'
import type { ChatApproval } from './native-chat-interactive-prompt'

/** A structured approval as the approval card draws it; options answer with journal ids. */
export function structuredApprovalCard(body: AgentJournalApprovalItem): ChatApproval {
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
