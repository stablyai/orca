import { useAppStore } from '@/store'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status/evidence/agent-status-terminal-title'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../../../../../shared/agent-status/title/agent-title-owner'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resolveRendererOwnedAgentStatusTiming
} from '../../agent-status/renderer-owned-agent-status-registry'
import { rendererAgentStatusObservations } from '@/lib/agent-status/evidence/renderer-agent-status-observations'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installRendererOwnedPaneStatus(session: ConnectPanePtySession): void {
  session.shouldOwnAgentStatusInRenderer = session.runtimeEnvironmentId !== null
  // Claim renderer-derived status once per transport so host mirroring cannot overwrite or delete its live row.
  session.releaseRendererOwnedAgentStatusPane =
    session.runtimeEnvironmentId !== null
      ? registerRendererOwnedAgentStatusPane(session.cacheKey, session.runtimeEnvironmentId)
      : null
  session.handleRendererOwnedAgentStatus = (payload): void => {
    const currentState = useAppStore.getState()
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!routing) {
      return
    }
    const title = currentState.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const authoritativePaneAgent = session.getAuthoritativePaneAgent()
    const agentType = resolveCompatibleAgentTypeForOwner(payload.agentType, authoritativePaneAgent)
    const statusPayload = agentType === payload.agentType ? payload : { ...payload, agentType }
    const observedStatusPayload = {
      ...statusPayload,
      observation: rendererAgentStatusObservations.observe(session.cacheKey, {
        origin: 'osc',
        observedAt: Date.now(),
        kind: 'snapshot'
      })
    }
    const resolvedStatusTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
    const statusTitle = resolvedStatusTitle
      ? normalizeCompatibleAgentTitleForOwner(
          resolvedStatusTitle,
          agentType ?? authoritativePaneAgent
        )
      : resolvedStatusTitle
    // Only actual byte-derived status proves authority to fence out host mirroring.
    markRendererOwnedAgentStatusWrite(session.cacheKey)
    const timing = resolveRendererOwnedAgentStatusTiming(
      currentState.agentStatusByPaneKey.get(session.cacheKey)
    )
    if (session.launchToken) {
      currentState.setAgentStatus(
        session.cacheKey,
        observedStatusPayload,
        statusTitle,
        timing,
        routing,
        {
          launchToken: session.launchToken
        }
      )
    } else {
      currentState.setAgentStatus(
        session.cacheKey,
        observedStatusPayload,
        statusTitle,
        timing,
        routing
      )
    }
    if (payload.state === 'working' && session.syncAgentTaskCompleteTrackingEnabled()) {
      session.requiresFreshWorkingForAgentTaskCompleteNotification = false
    }
    const storedStatus = useAppStore.getState().agentStatusByPaneKey.get(session.cacheKey)
    const notificationPayload =
      typeof storedStatus?.stateStartedAt === 'number'
        ? { ...statusPayload, stateStartedAt: storedStatus.stateStartedAt }
        : statusPayload
    // Why: hook lifecycle owns deferred side effects even when alerts are disabled.
    session.agentCompletionCoordinator.observeHookStatus(notificationPayload)
    if (payload.state === 'working' && session.pendingTerminalBellNotification) {
      session.scheduleTerminalBellNotification()
    }
  }
}
