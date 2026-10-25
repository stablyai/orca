import type { WorkspaceStatusDefinition } from './worktree/types'
import {
  getWorkspaceStatus,
  isWorkspaceStatusId,
  normalizeWorkspaceStatuses
} from './workspace-statuses'

export type WorkspaceStatusWarning = {
  code: 'UNKNOWN_WORKSPACE_STATUS'
  message: string
  details: { requestedId: string; effectiveId: string; validIds: string[] }
}

export function getWorkspaceStatusWarning(
  requestedId: string | undefined,
  readStatuses: () => unknown
): WorkspaceStatusWarning | undefined {
  if (requestedId === undefined) {
    return undefined
  }
  let statuses: WorkspaceStatusDefinition[]
  try {
    statuses = normalizeWorkspaceStatuses(readStatuses())
  } catch {
    // A columns read must not turn a successful metadata write into a failure.
    return undefined
  }
  if (isWorkspaceStatusId(requestedId, statuses)) {
    return undefined
  }
  const effectiveId = getWorkspaceStatus({ workspaceStatus: requestedId }, statuses)
  const label = statuses.find((status) => status.id === effectiveId)?.label ?? effectiveId
  const validIds = statuses.map((status) => status.id)
  return {
    code: 'UNKNOWN_WORKSPACE_STATUS',
    message: `Unknown workspace status ${JSON.stringify(requestedId)}. The board will show this workspace under ${JSON.stringify(label)} (${effectiveId}). Valid status ids: ${validIds.join(', ')}. The requested value was saved.`,
    details: { requestedId, effectiveId, validIds }
  }
}
