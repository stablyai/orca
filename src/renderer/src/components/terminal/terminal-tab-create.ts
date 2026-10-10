import { useAppStore } from '@/store'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'

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
  state.setActiveTabType('terminal', activeWorktreeId)
  // Why: without a saved order the tab bar falls back to terminals-first, so
  // persist the current visual order with the new terminal last.
  persistAgentLaunchTabOrder(activeWorktreeId, newTab.id)
}
