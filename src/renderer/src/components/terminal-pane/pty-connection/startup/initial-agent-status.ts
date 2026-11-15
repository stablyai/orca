import { useAppStore } from '@/store'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'
import { rendererAgentStatusObservations } from '@/lib/agent-status/evidence/renderer-agent-status-observations'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindInitialAgentStatus(session: ConnectPanePtySession): void {
  session.applyInitialAgentStatus = (terminalTitle?: string): void => {
    const startup = session.paneStartup
    const initialStatus = startup?.initialAgentStatus
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!initialStatus || !routing || startup.resumeSource?.cancelled) {
      return
    }
    const statusPayload = {
      state: 'working' as const,
      prompt: initialStatus.prompt,
      agentType: resolveCompatibleAgentTypeForOwner(
        initialStatus.agent,
        session.getAuthoritativePaneAgent()
      ),
      observation: rendererAgentStatusObservations.observe(session.cacheKey, {
        origin: 'launch',
        observedAt: Date.now(),
        kind: 'transition'
      })
    }
    if (session.paneStartup.launchConfig) {
      useAppStore
        .getState()
        .setAgentStatus(session.cacheKey, statusPayload, terminalTitle, undefined, routing, {
          launchConfig: session.paneStartup.launchConfig,
          ...(session.launchToken ? { launchToken: session.launchToken } : {})
        })
    } else {
      useAppStore
        .getState()
        .setAgentStatus(session.cacheKey, statusPayload, terminalTitle, undefined, routing)
    }
    if (startup.resumeSource) {
      session.savedStartupStatus = {
        source: startup.resumeSource,
        entry: useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      }
    }
  }
}
