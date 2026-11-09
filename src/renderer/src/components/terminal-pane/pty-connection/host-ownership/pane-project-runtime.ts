import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindPaneProjectRuntime(session: ConnectPanePtySession): void {
  session.localWindowsTerminalCapabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  session.projectRuntime =
    !session.tab?.forceHostRuntime &&
    session.runtimeEnvironmentId === null &&
    (!session.ownerContext.selectedHost || session.ownerContext.projectRuntimeTarget)
      ? getLocalProjectExecutionRuntimeContext(
          session.state,
          session.deps.worktreeId,
          undefined,
          {
            wslAvailable: session.localWindowsTerminalCapabilities?.wslAvailable,
            availableWslDistros: session.localWindowsTerminalCapabilities?.wslDistros ?? null
          },
          session.ownerContext.projectRuntimeTarget
        )
      : undefined
}
