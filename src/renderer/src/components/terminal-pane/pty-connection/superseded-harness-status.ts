import { useAppStore } from '@/store'
import { isFreshNonDoneAgentStatus, type AgentType } from '../../../../../shared/agent-status-types'
import { shareCompatibleTitleIdentityGroup } from '../../../../../shared/agent-title-owner'
import { shouldRetireFinishedHarnessSnapshot } from '@/components/sidebar/retire-stale-harness-snapshot'

export function retireSupersededHarnessStatus(
  paneKey: string,
  occupant: AgentType,
  options?: { allowStaleNonDone?: boolean }
): void {
  const state = useAppStore.getState()
  const retained = state.retainedAgentsByPaneKey[paneKey]
  const shouldRetireRetained =
    retained &&
    shouldRetireFinishedHarnessSnapshot({
      finishedAgent: retained.entry.agentType ?? retained.tab.launchAgent,
      finishedState: retained.entry.state,
      occupantAgent: occupant
    })
  const live = state.agentStatusByPaneKey[paneKey]
  const shouldRetireLive =
    Boolean(
      live &&
      shouldRetireFinishedHarnessSnapshot({
        finishedAgent: live.agentType,
        finishedState: live.state,
        occupantAgent: occupant
      })
    ) ||
    (options?.allowStaleNonDone === true &&
      live !== undefined &&
      live.state !== 'done' &&
      live.agentType !== undefined &&
      live.agentType !== 'unknown' &&
      !shareCompatibleTitleIdentityGroup(live.agentType, occupant) &&
      !isFreshNonDoneAgentStatus(live))
  if (!shouldRetireRetained && !shouldRetireLive) {
    return
  }
  if (shouldRetireRetained && live && !shouldRetireLive) {
    state.dismissRetainedAgent(paneKey)
    return
  }

  const launchConfig = state.agentLaunchConfigByPaneKey[paneKey]
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  // Why: retirement must fence replay at the host, but its broad cleanup also owns current occupant metadata.
  state.retireAgentPaneAuthority(paneKey)
  useAppStore.setState((current) => ({
    ...(launchConfig && shareCompatibleTitleIdentityGroup(launchConfig.identity.agentType, occupant)
      ? {
          agentLaunchConfigByPaneKey: {
            ...current.agentLaunchConfigByPaneKey,
            [paneKey]: launchConfig
          }
        }
      : {}),
    ...(foreground &&
    (foreground.shellForeground === true ||
      (foreground.agent && shareCompatibleTitleIdentityGroup(foreground.agent, occupant)))
      ? {
          paneForegroundAgentByPaneKey: {
            ...current.paneForegroundAgentByPaneKey,
            [paneKey]: foreground
          }
        }
      : {})
  }))
}
