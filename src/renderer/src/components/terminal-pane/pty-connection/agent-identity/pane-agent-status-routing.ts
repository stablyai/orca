import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status/ownership/agent-status-connection-ownership'
import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindPaneAgentStatusRouting(session: ConnectPanePtySession): void {
  session.resolveCurrentAgentStatusRouting = () => {
    const ptyId = session.activePanePtyBinding ?? session.transport.getPtyId()
    const state = useAppStore.getState()
    if (session.disposed || !ptyId) {
      return undefined
    }
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey: session.cacheKey,
      ptyId,
      expectedConnectionId: session.worktreeConnectionId,
      runtimeEnvironmentId:
        session.transport.getRuntimeEnvironmentId?.() ?? session.runtimeEnvironmentId
    })
  }
}
