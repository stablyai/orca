import type { TerminalForegroundServices } from './terminal-foreground-services'
import { useAppStore } from '@/store'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'

export function isPaneForegroundTrackingAllowed(
  id: string,
  services: TerminalForegroundServices
): boolean {
  if (isRemoteExecutionHostPtyId(id)) {
    return true
  }
  if (!navigator.userAgent.includes('Windows')) {
    return true
  }
  const state = useAppStore.getState()
  const tab = (state.tabsByWorktree[services.worktreeId] ?? []).find(
    (candidate) => candidate.id === services.tabId
  )
  // WSL/remote panes cannot authorize native ConPTY bytes, so skip Windows scans that cannot affect routing.
  return (
    services.executionHost === 'local' &&
    isLocalNativeWindowsConpty({
      userAgent: navigator.userAgent,
      connectionId: null,
      cwd: services.cwd,
      shellOverride: resolveWindowsShellOverride(
        tab?.shellOverride,
        state.settings?.terminalWindowsShell
      ),
      executionHostId: services.executionHost
    })
  )
}
