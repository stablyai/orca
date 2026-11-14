import type { AppState } from '@/store/types'
import { agentTypeToIconAgent } from '../../../../../../shared/agent-status/presentation/agent-type-icon-agent'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'

export type PaneKnownAgentIdentityState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'paneForegroundAgentByPaneKey' | 'agentLaunchConfigByPaneKey'
>

export function paneHasLiveHookAgentIcon(
  state: Pick<AppState, 'agentStatusByPaneKey'>,
  paneKey: string
): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.state !== 'done' && Boolean(agentTypeToIconAgent(entry?.agentType))
}

/** Process-read, live-hook or launch-registered agent identity already tracked for this pane. */
export function paneHasKnownAgentIdentity(
  state: PaneKnownAgentIdentityState,
  paneKey: string
): boolean {
  return (
    Boolean(state.paneForegroundAgentByPaneKey[paneKey]?.agent) ||
    paneHasLiveHookAgentIcon(state, paneKey) ||
    isTuiAgent(state.agentLaunchConfigByPaneKey[paneKey]?.identity?.agentType)
  )
}
