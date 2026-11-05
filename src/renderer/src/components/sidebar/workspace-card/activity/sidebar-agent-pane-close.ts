import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { requestActiveTerminalPaneClose } from '@/components/terminal-pane/request-active-terminal-pane-close'
import { useAppStore } from '@/store'

const pending = new Map<string, Promise<boolean>>()

/** Reuse the pane's running-process guard even when its terminal surface is parked. */
export function closeSidebarAgentPane(
  worktreeId: string,
  tabId: string,
  leafId: string
): Promise<boolean> {
  const key = `${worktreeId}\0${tabId}\0${leafId}`
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  if (requestActiveTerminalPaneClose(tabId, leafId)) {
    return Promise.resolve(true)
  }
  const operation = new Promise<boolean>((resolve) => {
    const deadline = Date.now() + 8_000
    const retry = (): void => {
      const state = useAppStore.getState()
      if (!state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
        resolve(true)
      } else if (requestActiveTerminalPaneClose(tabId, leafId)) {
        resolve(true)
      } else if (Date.now() >= deadline) {
        resolve(false)
      } else {
        setTimeout(retry, 100)
      }
    }
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
    setTimeout(retry, 0)
  }).finally(() => pending.delete(key))
  pending.set(key, operation)
  return operation
}
