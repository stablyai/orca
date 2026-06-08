import type { WorkspaceSessionState } from '../../../shared/types'

export function buildSleepingAgentSessionData(snapshot: {
  sleepingAgentSessionsByPaneKey?: WorkspaceSessionState['sleepingAgentSessionsByPaneKey']
}): Pick<WorkspaceSessionState, 'sleepingAgentSessionsByPaneKey'> {
  const records = snapshot.sleepingAgentSessionsByPaneKey
  return records && Object.keys(records).length > 0
    ? { sleepingAgentSessionsByPaneKey: records }
    : {}
}
