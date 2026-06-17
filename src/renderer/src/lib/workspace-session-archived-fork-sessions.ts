import type { WorkspaceSessionState } from '../../../shared/types'

export function buildArchivedForkableAgentSessionData(snapshot: {
  archivedForkableAgentSessionsByPaneKey?: WorkspaceSessionState['archivedForkableAgentSessionsByPaneKey']
}): Pick<WorkspaceSessionState, 'archivedForkableAgentSessionsByPaneKey'> {
  const records = snapshot.archivedForkableAgentSessionsByPaneKey
  return records && Object.keys(records).length > 0
    ? { archivedForkableAgentSessionsByPaneKey: records }
    : {}
}
