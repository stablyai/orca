import { useAppStore } from '@/store'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { createBrowserUuid } from '@/lib/browser-uuid'

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
      shell: shellOverride,
      ...(options?.startupCwd ? { cwd: options.startupCwd } : {}),
      activate: true
    })
    return
  }
  const tabId = createBrowserUuid()
  state.createTab(activeWorktreeId, undefined, shellOverride, {
    id: tabId,
    ...(options?.startupCwd ? { startupCwd: options.startupCwd } : {})
  })
  state.setActiveTabType('terminal', activeWorktreeId)
  // Why: without a saved order the tab bar falls back to terminals-first, so
  // persist the current visual order with the new terminal last.
  persistAgentLaunchTabOrder(activeWorktreeId, tabId)
}
