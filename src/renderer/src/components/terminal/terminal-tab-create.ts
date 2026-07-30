import { useAppStore } from '@/store'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'

export function createNewTerminalTab(
  activeWorktreeId: string | null,
  shellOverride?: string,
  options?: { startupCwd?: string }
): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const worktreeRoute = resolveTerminalWorktreeRoute(state, activeWorktreeId)
  if (!worktreeRoute) {
    return
  }
  const runtimeEnvironmentId = worktreeRoute.runtimeEnvironmentId
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: paired web clients receive host-owned terminal tabs through
    // session.tabs. Creating a local tab first races the host snapshot and can
    // leave stale remote handles in the web store.
    void createWebRuntimeSessionTerminal({
      worktreeId: activeWorktreeId,
      environmentId: runtimeEnvironmentId,
      command: shellOverride,
      ...(options?.startupCwd ? { cwd: options.startupCwd } : {}),
      activate: true
    })
    return
  }
  const newTab = state.createTab(
    activeWorktreeId,
    undefined,
    shellOverride,
    options?.startupCwd ? { startupCwd: options.startupCwd } : undefined
  )
  state.setActiveTabType('terminal')
  // Why: persist the tab bar order with the new terminal at the end of the
  // current visual order. Without this, reconcileTabOrder falls back to
  // terminals-first when tabBarOrderByWorktree is unset, causing a new
  // terminal to jump to index 0 instead of appending after editor tabs.
  const freshState = useAppStore.getState()
  const termIds = (freshState.tabsByWorktree[activeWorktreeId] ?? []).map((t) => t.id)
  const editorIds = freshState.openFiles
    .filter((f) => f.worktreeId === activeWorktreeId)
    .map((f) => f.id)
  const base = reconcileTabOrder(
    freshState.tabBarOrderByWorktree[activeWorktreeId],
    termIds,
    editorIds
  )
  // The new tab is already in base via termIds; move it to the end
  const order = base.filter((id) => id !== newTab.id)
  order.push(newTab.id)
  state.setTabBarOrder(activeWorktreeId, order)
}
