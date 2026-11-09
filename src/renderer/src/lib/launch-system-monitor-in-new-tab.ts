import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import type { SystemMonitorDescriptor } from '../../../shared/system-monitors'

export type LaunchSystemMonitorInNewTabArgs = {
  monitor: SystemMonitorDescriptor
  worktreeId: string
  groupId?: string | null
}

/** Spawns an interactive shell tab titled after the monitor and queues its TUI startup command. */
export function launchSystemMonitorInNewTab({
  monitor,
  worktreeId,
  groupId
}: LaunchSystemMonitorInNewTabArgs): { tabId: string } | null {
  const command = monitor.command.trim()
  if (!command) {
    return null
  }
  const store = useAppStore.getState()
  const tab = store.createTab(worktreeId, groupId ?? undefined, undefined, {
    quickCommandLabel: monitor.label,
    pendingStartup: { command }
  })
  store.setActiveTabType('terminal', worktreeId)
  persistAgentLaunchTabOrder(worktreeId, tab.id)
  return { tabId: tab.id }
}
