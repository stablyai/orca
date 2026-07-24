import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { useAppStore } from '@/store'
import {
  activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'

export function activateTerminalTab(tabId: string): void {
  const state = useAppStore.getState()
  const owningWorktreeId =
    Object.entries(state.tabsByWorktree).find(([, tabs]) =>
      tabs.some((tab) => tab.id === tabId)
    )?.[0] ?? null
  const route = resolveTerminalWorktreeRoute(state, owningWorktreeId)
  if (!route) {
    return
  }
  if (owningWorktreeId && isWebRuntimeSessionActive(route.runtimeEnvironmentId)) {
    void activateWebRuntimeSessionTab({
      worktreeId: owningWorktreeId,
      tabId,
      environmentId: route.runtimeEnvironmentId
    })
  }
  state.setActiveTab(tabId)
  state.setActiveTabType('terminal')
}

export function toggleTerminalPaneExpand(tabId: string): void {
  useAppStore.getState().setActiveTab(tabId)
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId }
      })
    )
  })
}
