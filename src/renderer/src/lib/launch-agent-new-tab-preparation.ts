import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'

export type PreparedAgentInNewTabLaunch = {
  store: ReturnType<typeof useAppStore.getState>
  worktreeSshConnectionId: string | null | undefined
  effectiveAgentArgs: string | null | undefined
  trimmedPrompt: string
  hasPrompt: boolean
  viewModePromptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  initialViewModeProps: ReturnType<typeof initialAgentTabViewModeProps>
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
}

export function prepareAgentInNewTabLaunch(
  args: LaunchAgentInNewTabArgs
): PreparedAgentInNewTabLaunch | null {
  const {
    agent,
    worktreeId,
    agentArgs,
    prompt,
    promptDelivery = 'auto-submit',
    launchPlatform,
    initialSessionOptions
  } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees?.().find((entry: { id: string }) => entry.id === worktreeId)
  const repo = worktree ? store.repos?.find((entry) => entry.id === worktree.repoId) : null
  const worktreeSshConnectionId = getConnectionIdFromState(store, worktreeId)
  const resolvedLaunchPlatform =
    launchPlatform ??
    (repo
      ? getAgentLaunchPlatformForRepo(
          repo,
          worktreeSshConnectionId
            ? undefined
            : getLocalProjectExecutionRuntimeContext(store, worktreeId)
        )
      : CLIENT_PLATFORM)
  const isRemote = Boolean(worktreeSshConnectionId)
  const queuedShell = resolveLocalWindowsAgentStartupShell({
    platform: resolvedLaunchPlatform,
    isRemote,
    terminalWindowsShell: store.settings?.terminalWindowsShell
  })
  const effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeOptions = {
    agent,
    promptDelivery: viewModePromptDelivery,
    launchDraftText: trimmedPrompt,
    nativeChatTranscriptIsLocalReadable:
      isNativeChatTranscriptLocalReadable(worktreeSshConnectionId)
  }
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, initialViewModeOptions)
  const sessionOptions =
    initialSessionOptions ??
    resolveInitialNativeChatSessionOptions(store.settings, initialViewModeOptions)
  const { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt } = planLaunchAgentStartupPrompt({
    base: {
      agent,
      cmdOverrides: store.settings?.agentCmdOverrides ?? {},
      platform: resolvedLaunchPlatform,
      shell: queuedShell,
      isRemote,
      agentArgs: effectiveAgentArgs,
      agentEnv,
      sessionOptions
    },
    prompt: trimmedPrompt,
    promptDelivery,
    isFollowupPath
  })
  return startupPlan
    ? {
        store,
        worktreeSshConnectionId,
        effectiveAgentArgs,
        trimmedPrompt,
        hasPrompt,
        viewModePromptDelivery,
        initialViewModeProps,
        startupPlan,
        pasteDraftAfterLaunch,
        submitPastedPrompt
      }
    : null
}
