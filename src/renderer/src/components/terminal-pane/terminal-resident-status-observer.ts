import { useAppStore } from '@/store'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../../../shared/agent-title-owner'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import {
  markRendererOwnedAgentStatusWrite,
  resolveRendererOwnedAgentStatusTiming
} from './renderer-owned-agent-status-registry'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import type { TerminalResidentBinding } from './terminal-resident-policy'
import type { createTerminalShellInputPolicy } from './pty-connection/terminal-shell-input-policy'
import type { createTerminalNotificationPolicy } from './pty-connection/terminal-notification-policy'
import type { createTerminalCompletionPolicy } from './pty-connection/terminal-completion-policy'

export function createTerminalResidentStatusObserver(services: {
  binding: TerminalResidentBinding
  getPtyId: () => string | null
  readTitle: () => string | null
  shellInput: ReturnType<typeof createTerminalShellInputPolicy>
  notification: ReturnType<typeof createTerminalNotificationPolicy>
  completion: ReturnType<typeof createTerminalCompletionPolicy>
}) {
  return (payload: ParsedAgentStatusPayload, observedAt = Date.now(), quiet = false) => {
    const ptyId = services.getPtyId()
    if (!ptyId || (!services.binding.runtimeEnvironmentId && !parseRemoteRuntimePtyId(ptyId))) {
      return
    }
    const state = useAppStore.getState()
    const routing = resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey: services.binding.paneKey,
      ptyId,
      expectedConnectionId: getConnectionIdFromState(state, services.binding.worktreeId)
    })
    if (!routing) {
      return
    }
    const authoritativeAgent = services.shellInput.getAuthoritativePaneAgent()
    const agentType = resolveCompatibleAgentTypeForOwner(payload.agentType, authoritativeAgent)
    const status = agentType === payload.agentType ? payload : { ...payload, agentType }
    const title = resolveAgentStatusTerminalTitle(status, services.readTitle() ?? undefined)
    markRendererOwnedAgentStatusWrite(services.binding.paneKey)
    const observed = {
      ...status,
      observation: rendererAgentStatusObservations.observe(services.binding.paneKey, {
        origin: 'osc',
        observedAt,
        kind: 'snapshot'
      })
    }
    const normalizedTitle = title
      ? normalizeCompatibleAgentTitleForOwner(title, agentType ?? authoritativeAgent)
      : title
    const timing = resolveRendererOwnedAgentStatusTiming(
      state.agentStatusByPaneKey[services.binding.paneKey]
    )
    if (services.binding.launchToken) {
      state.setAgentStatus(
        services.binding.paneKey,
        observed,
        normalizedTitle,
        quiet
          ? { updatedAt: observedAt, evidenceObservedAt: observedAt, stateStartedAt: observedAt }
          : timing,
        routing,
        { launchToken: services.binding.launchToken }
      )
    } else {
      state.setAgentStatus(
        services.binding.paneKey,
        observed,
        normalizedTitle,
        quiet
          ? { updatedAt: observedAt, evidenceObservedAt: observedAt, stateStartedAt: observedAt }
          : timing,
        routing
      )
    }
    if (quiet) {
      return
    }
    if (
      payload.state === 'working' &&
      services.notification.syncAgentTaskCompleteTrackingEnabled()
    ) {
      services.notification.requiresFreshWorkingForAgentTaskCompleteNotification = false
    }
    const stored = useAppStore.getState().agentStatusByPaneKey[services.binding.paneKey]
    services.completion.observeHookStatus(
      typeof stored?.stateStartedAt === 'number'
        ? { ...status, stateStartedAt: stored.stateStartedAt }
        : status
    )
    if (payload.state === 'working' && services.notification.pendingTerminalBellNotification) {
      services.notification.scheduleTerminalBellNotification()
    }
  }
}
