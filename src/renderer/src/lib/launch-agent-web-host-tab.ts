import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import type { Tab, TuiAgent } from '../../../shared/types'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import { translate } from '@/i18n/i18n'

function removeStaleLocalAgentTabsForWebHostLaunch(worktreeId: string): void {
  const state = useAppStore.getState()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (tab.launchAgent && !isWebTerminalSurfaceTabId(tab.id)) {
      // Why: pruning a stale local agent tab is a system close — keep it out of
      // the Cmd+Shift+T reopen stack.
      state.closeTab(tab.id, { reason: 'cleanup' })
    }
  }
}

/**
 * Launch an agent terminal on the web runtime host instead of a local tab.
 *
 * Why: paired web tabs are host-owned, so this path never creates a local tab
 * (callers return tabId: null). Local-only agent tabs cannot be closed because
 * close routes through session.tabs.close on the host, so prune them before
 * the host snapshot.
 */
export function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  cwd?: string | null
  hasPrompt: boolean
  agentLaunch: AgentLaunchSpawnRequest
  promptAfterReady?: {
    content: string
    submit: boolean
    forcePaste: boolean
  }
  viewMode?: Tab['viewMode']
  onPromptDelivered?: () => void
}): Promise<{ delivered: boolean; failureNotified: boolean }> {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    cwd,
    hasPrompt,
    agentLaunch,
    promptAfterReady,
    viewMode,
    onPromptDelivered
  } = args
  removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
  // Why: the host resolves the launch from `agentLaunch` (identity + prompt
  // policy only); the client never sends an assembled command/config/token.
  const launch = {
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate: true,
    ...(cwd?.trim() ? { cwd } : {}),
    ...(viewMode ? { viewMode } : {}),
    agentLaunch
  }
  const creation = promptAfterReady
    ? createWebRuntimeAgentSessionTerminal({
        ...launch,
        agent,
        promptAfterReady: promptAfterReady.content,
        submitPrompt: promptAfterReady.submit,
        forcePromptPaste: promptAfterReady.forcePaste
      })
    : agentLaunch.promptDelivery === 'draft' && agentLaunch.prompt
      ? createWebRuntimeAgentSessionTerminalWithLaunchDraft({
          ...launch,
          agent,
          launchDraft: agentLaunch.prompt
        })
      : createWebRuntimeSessionTerminal(launch)

  const handleCreation = ({
    outcome,
    promptDelivered
  }: {
    outcome: Awaited<ReturnType<typeof createWebRuntimeSessionTerminal>>
    promptDelivered: boolean
  }): { delivered: boolean; failureNotified: boolean } => {
    // Why: created means the host accepted the launch, not that a local tab
    // exists; keep pruning stale local rows until the snapshot mirrors.
    removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
    if (outcome.status === 'failed') {
      toast.error(
        outcome.message ||
          translate(
            'auto.lib.launch.agent.in.new.tab.11cce5cc77',
            'Could not launch {{value0}} in a new terminal.',
            { value0: agent }
          )
      )
      return { delivered: false, failureNotified: true }
    }
    useAppStore.getState().setActiveTabType('terminal')
    if (hasPrompt && promptDelivered) {
      onPromptDelivered?.()
    }
    return { delivered: promptDelivered, failureNotified: false }
  }

  return creation.then((result) =>
    'outcome' in result
      ? handleCreation(result)
      : handleCreation({
          outcome: result,
          promptDelivered: result.status === 'created' && hasPrompt
        })
  )
}
