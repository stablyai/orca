import { useCallback } from 'react'
import { useAgentPresentation } from '../../sidebar/workspace-card/activity/useWorktreeAgentRows'

export function useTerminalTabAgentTypes(tabId: string) {
  return useAgentPresentation(
    `terminal-types\0${tabId}`,
    useCallback((projection) => projection.terminalLeafAgentTypes(tabId), [tabId])
  )
}
