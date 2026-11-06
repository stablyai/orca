import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import type { PaneForegroundAgentTrackerDeps } from '../pane-foreground-agent-tracker-contract'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type PaneForegroundReaderDeps = Pick<
  PaneForegroundAgentTrackerDeps,
  | 'readForegroundProcess'
  | 'confirmForegroundProcess'
  | 'isRemotePtyId'
  | 'getExpectedIncarnationId'
>

/** One source for how a pane reads its PTY's foreground process, local or on a runtime host. */
export function createPaneForegroundReaderDeps(
  session: ConnectPanePtySession
): PaneForegroundReaderDeps {
  return {
    readForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.confirmForegroundProcess(id),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => session.remotePtyIncarnationId ?? null
  }
}
