import type { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { agentTabsDefaultToNativeChat } from '../../../shared/structured-native-chat-launch-route'
import type { TerminalTabViewMode } from '../../../shared/terminal-tab-view-mode'

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

/** Whether the host owning this worktree stamps a launch's starting view at creation. */
export function hostStampsLaunchView(state: AppStoreSnapshot, worktreeId: string): boolean {
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!environmentId) {
    return true
  }
  return (
    state.runtimeStatusByEnvironmentId
      ?.get(environmentId)
      ?.status?.capabilities?.includes(AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY) === true
  )
}

/**
 * What this device asks a stamping host for: its Chat UI default, which the host applies like its
 * own, plus a terminal pin only when chat could not mirror the launch draft.
 */
export function hostLaunchViewRequest(
  settings: Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'> | null,
  options: Parameters<typeof initialAgentTabViewModeProps>[1] = {}
): { viewMode?: 'terminal'; launcherDefaultView?: TerminalTabViewMode } {
  if (!options.agent) {
    return {}
  }
  const pinned = initialAgentTabViewModeProps(settings, options).viewMode === 'terminal'
  return {
    ...(pinned ? { viewMode: 'terminal' as const } : {}),
    launcherDefaultView: agentTabsDefaultToNativeChat(settings) ? 'chat' : 'terminal'
  }
}
