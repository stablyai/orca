import { currentCodexAccountRestart } from '@/store/terminals/codex-account-restart-continuation'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindPaneProjectRuntime(session: ConnectPanePtySession): void {
  session.localWindowsTerminalCapabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  const accountRequest = session.deps.accountRestartToken
    ? currentCodexAccountRestart(session.state, session.deps.accountRestartToken)
    : null
  session.shellOverride = accountRequest ? accountRequest.shellOverride : session.tab?.shellOverride
  if (accountRequest) {
    session.projectRuntime = accountRequest.projectRuntime
    return
  }
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
