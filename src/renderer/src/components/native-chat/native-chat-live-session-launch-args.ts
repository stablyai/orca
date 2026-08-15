import { useAppStore } from '../../store'

/** The live session's actual launch args/env (not settings.agentDefaultArgs,
 *  which is only the default for *new* sessions — see #10886). Read from the
 *  pane's status entry so a stale global default never masquerades as the
 *  flag this session actually launched with. */
export function resolveNativeChatLiveSessionLaunchArgs(paneKey?: string): {
  agentArgs?: string
  agentEnv?: Record<string, string>
} {
  const state = useAppStore.getState()
  const statusEntry = paneKey ? state.agentStatusByPaneKey?.[paneKey] : undefined
  const launchConfig = statusEntry
    ? state.getAgentLaunchConfigForStatusEntry(statusEntry)
    : undefined
  return { agentArgs: launchConfig?.agentArgs, agentEnv: launchConfig?.agentEnv }
}
