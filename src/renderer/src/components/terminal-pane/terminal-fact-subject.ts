import { useAppStore } from '@/store'

/** References name the original row and launch, including their explicit absence. */
export function captureTerminalFactSubject(paneKey: string): {
  row: ReturnType<typeof useAppStore.getState>['agentStatusByPaneKey'][string]
  launch: ReturnType<typeof useAppStore.getState>['agentLaunchConfigByPaneKey'][string]
  isCurrent: () => boolean
  captureCurrent: () => TerminalFactSubject
} {
  const state = useAppStore.getState()
  const row = state.agentStatusByPaneKey[paneKey]
  const launch = state.agentLaunchConfigByPaneKey[paneKey]
  return {
    row,
    launch,
    captureCurrent: () => captureTerminalFactSubject(paneKey),
    isCurrent: () => {
      const current = useAppStore.getState()
      return (
        current.agentStatusByPaneKey[paneKey] === row &&
        current.agentLaunchConfigByPaneKey[paneKey] === launch
      )
    }
  }
}
export type TerminalFactSubject = ReturnType<typeof captureTerminalFactSubject>
