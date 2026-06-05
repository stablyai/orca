import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { isWslUncPath } from '../../../shared/wsl-paths'

function getResumeLaunchPlatform(worktreeId: string): NodeJS.Platform {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  if (repo?.connectionId || (worktree?.path && isWslUncPath(worktree.path))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

function appendTabToWorktreeOrder(worktreeId: string, tabId: string): void {
  const state = useAppStore.getState()
  const termIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((f) => f.id)
  const browserIds = (state.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const base = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tabId)
  order.push(tabId)
  state.setTabBarOrder(worktreeId, order)
}

export function resumeSleepingAgentSession(paneKey: string): boolean {
  const state = useAppStore.getState()
  const record = state.sleepingAgentSessionsByPaneKey[paneKey]
  if (!record) {
    return false
  }
  const startupPlan = buildAgentResumeStartupPlan({
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    platform: getResumeLaunchPlatform(record.worktreeId)
  })
  if (!startupPlan) {
    toast.error('This agent session cannot be resumed.')
    return false
  }

  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    launchAgent: record.agent
  })
  state.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(record.agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  state.clearSleepingAgentSession(record.paneKey)
  state.setActiveTabType('terminal')
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  activateAndRevealWorktree(record.worktreeId, { sidebarRevealBehavior: 'auto' })
  return true
}
