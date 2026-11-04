import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { buildWindowsPtyCompatibilityOptions } from '@/lib/pane-manager/windows-pty-compatibility'
import {
  resolveRemotePtyOwnerMachinePlatform,
  type PtyOwnerMachineState
} from '../pty-owner-machine-platform'

export type PaneWindowsPtyModelContext = {
  terminal: Pick<Terminal, 'options'>
  owner: { executionHostId: ExecutionHostId; runtimeEnvironmentId: string | null }
  connectionId: string | null | undefined
  cwd?: string | null
  shellOverride?: string | null
}

/**
 * Give the pane's xterm the resize model of the machine that owns its PTY, so growing rows never
 * pulls history into a ConPTY grid that repaints from its own view. Runs at mount and again at
 * PTY bind, because a paired server's OS can arrive after the pane mounts.
 */
export function applyPaneWindowsPtyModel(
  context: PaneWindowsPtyModelContext,
  state: PtyOwnerMachineState = useAppStore.getState()
): void {
  const { windowsPty } = buildWindowsPtyCompatibilityOptions({
    userAgent: navigator.userAgent,
    osRelease: window.api.platform?.get?.()?.osRelease,
    connectionId: context.connectionId,
    cwd: context.cwd,
    shellOverride: context.shellOverride,
    executionHostId: context.owner.executionHostId,
    remoteOwnerPlatform: resolveRemotePtyOwnerMachinePlatform(state, context.owner)
  })
  if (windowsPty) {
    context.terminal.options.windowsPty = windowsPty
  }
}
