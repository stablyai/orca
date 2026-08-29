import type { LinkedWorkItemSummary } from '@/lib/new-workspace'

export async function assertPaperclipSubmitAdmission(
  linkedWorkItem: LinkedWorkItemSummary | null | undefined,
  targetIsLocal = true
): Promise<void> {
  if (linkedWorkItem?.provider !== 'paperclip') {
    return
  }
  if (!targetIsLocal) {
    throw new Error('Paperclip-linked workspaces are available only on the local Orca runtime.')
  }
  const issueId = linkedWorkItem.paperclipIssueId?.trim()
  const connectionId = linkedWorkItem.paperclipConnectionId?.trim()
  const companyId = linkedWorkItem.paperclipCompanyId?.trim()
  const projectId = linkedWorkItem.paperclipProjectId?.trim()
  if (!issueId || !connectionId || !companyId || !projectId) {
    throw new Error('The linked Paperclip scope is missing.')
  }
  const admission = await window.api.paperclip.getLaunchAdmission({
    issueId,
    connectionId,
    companyId,
    projectId
  })
  if (admission.allowed) {
    return
  }
  if (admission.reason === 'active_run') {
    throw new Error('Paperclip started an active run for this issue. Workspace creation stopped.')
  }
  if (admission.reason === 'claim_markers') {
    throw new Error('Paperclip claim markers changed. Workspace creation stopped.')
  }
  throw new Error('Paperclip run state is unknown. Workspace creation stopped.')
}
