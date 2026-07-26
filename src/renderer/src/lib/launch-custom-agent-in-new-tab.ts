import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import type { CustomAgent } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'

export type LaunchCustomAgentResult = {
  tabId: string
} | null

/** Launch a user-defined custom agent (not in the built-in TuiAgent catalog). */
export function launchCustomAgentInNewTab(args: {
  agent: CustomAgent
  worktreeId: string
  groupId?: string
  prompt?: string
  launchSource?: LaunchSource
  onPromptDelivered?: () => void
}): LaunchCustomAgentResult {
  const { agent, worktreeId, groupId, prompt, launchSource, onPromptDelivered } = args
  const store = useAppStore.getState()

  const command = [agent.cmd, agent.args].filter(Boolean).join(' ')
  if (!command.trim()) {
    return null
  }

  const tab = store.createTab(worktreeId, groupId, undefined, {
    quickCommandLabel: agent.label,
    customLaunchAgentId: agent.id
  })

  store.queueTabStartupCommand(tab.id, {
    command,
    ...(agent.env && Object.keys(agent.env).length > 0 ? { env: agent.env } : {}),
    telemetry: {
      agent_kind: 'other',
      launch_source: launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  })

  if (prompt?.trim()) {
    store.queueTabStartupCommand(tab.id, {
      command: prompt,
      delivery: 'terminal-paste'
    })
    onPromptDelivered?.()
  }

  store.setActiveTabType('terminal')

  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(worktreeId, order)

  return { tabId: tab.id }
}
