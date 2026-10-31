import type { AgentJournalApprovalItem } from './agent-session-journal-types'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'
import { validateAgentSessionFormContent } from './agent-session-form'
export * from './agent-session-settled-body-wire'
export function isExactSettledApprovalBody(
  value: unknown,
  state: string
): value is AgentJournalApprovalItem {
  if (
    !isAdmissibleAgentJournalItemBody(value) ||
    value.kind !== 'approval' ||
    !value.form ||
    value.resolution.state !== state ||
    state === 'pending'
  ) {
    return false
  }
  const { formContent } = value.resolution
  if (formContent === undefined) {
    return state === 'cancelled' || value.resolution.selectedOptionId !== null
  }
  try {
    validateAgentSessionFormContent(value.form, formContent)
    return state === 'resolved' && value.resolution.selectedOptionId === null
  } catch {
    return false
  }
}
