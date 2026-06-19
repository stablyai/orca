import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

export type WebRuntimeAgentTabLaunchResult = {
  handled: boolean
  result: {
    tabId: null
    startupPlan: AgentStartupPlan
    pasteDraftAfterLaunch: false
  } | null
}

export function launchWebRuntimeAgentTab(args: {
  worktreeId: string
  environmentId: string | null
  groupId?: string
  agent: TuiAgent
  startupPlan: AgentStartupPlan
  hasPrompt: boolean
  onPromptDelivered?: () => void
}): WebRuntimeAgentTabLaunchResult {
  if (!args.environmentId) {
    return { handled: false, result: null }
  }
  const store = useAppStore.getState()
  removeStaleLocalAgentTabsForWebHostLaunch(args.worktreeId)
  void createWebRuntimeSessionTerminal({
    worktreeId: args.worktreeId,
    environmentId: args.environmentId,
    targetGroupId: args.groupId,
    activate: true,
    ...(args.hasPrompt
      ? {
          command: args.startupPlan.launchCommand,
          ...(args.startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: args.startupPlan.startupCommandDelivery }
            : {})
        }
      : { agent: args.agent })
  }).then((created) => {
    removeStaleLocalAgentTabsForWebHostLaunch(args.worktreeId)
    if (!created) {
      toast.error(
        translate(
          'auto.lib.launch.agent.in.new.tab.11cce5cc77',
          'Could not launch {{value0}} in a new terminal.',
          { value0: args.agent }
        )
      )
      return
    }
    store.setActiveTabType('terminal')
    if (args.hasPrompt) {
      args.onPromptDelivered?.()
    }
  })
  return {
    handled: true,
    result: { tabId: null, startupPlan: args.startupPlan, pasteDraftAfterLaunch: false }
  }
}

function removeStaleLocalAgentTabsForWebHostLaunch(worktreeId: string): void {
  const state = useAppStore.getState()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (tab.launchAgent && !isWebTerminalSurfaceTabId(tab.id)) {
      state.closeTab(tab.id)
    }
  }
}
