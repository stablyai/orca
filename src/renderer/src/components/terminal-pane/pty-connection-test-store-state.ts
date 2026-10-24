import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import type { createInitialStoreState } from './pty-connection-test-store-fixtures'

export type StoreState = ReturnType<Awaited<ReturnType<typeof createInitialStoreState>>['read']>

export type WindowsShiftEnterPaneState = Parameters<
  typeof resolveWindowsShiftEnterEncodingForPane
>[0]

export function resolveMockPaneWindowsShiftEnterEncoding(
  state: StoreState,
  paneKey: string
): ReturnType<typeof resolveWindowsShiftEnterEncodingForPane> {
  return resolveWindowsShiftEnterEncodingForPane(
    {
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey
    },
    paneKey
  )
}
