import { useAppStore } from '@/store'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { createBrowserUuid } from '@/lib/browser-uuid'

export function createNewTerminalTab(
  activeWorktreeId: string | null,
  shellOverride?: string,
  options?: {
    startupCwd?: string
    command?: string
    /** Reports whether the tab was created; a caller that passes it reports failure itself. */
    onSettled?: (started: boolean) => void
  }
): void {
  if (!activeWorktreeId) {
    options?.onSettled?.(false)
    return
  }
  const state = useAppStore.getState()
  const worktreeRoute = resolveTerminalWorktreeRoute(state, activeWorktreeId)
  if (!worktreeRoute) {
    options?.onSettled?.(false)
    return
  }
  const runtimeEnvironmentId = worktreeRoute.runtimeEnvironmentId
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Paired web clients receive host-owned tabs through session.tabs; creating locally races that snapshot and leaves stale handles.
    const onSettled = options?.onSettled
    const launch = createWebRuntimeSessionTerminal(
      {
        worktreeId: activeWorktreeId,
        environmentId: runtimeEnvironmentId,
        shell: shellOverride,
        ...(options?.startupCwd ? { cwd: options.startupCwd } : {}),
        ...(options?.command ? { command: options.command } : {}),
        activate: true
      },
      { userAct: true, ...(onSettled ? { notifyFailure: false } : {}) }
    )
    if (onSettled) {
      void launch.then(
        (outcome) => onSettled(outcome.status === 'created'),
        () => onSettled(false)
      )
    }
    return
  }
  const tabId = createBrowserUuid()
  state.createTab(activeWorktreeId, undefined, shellOverride, {
    id: tabId,
    ...(options?.startupCwd ? { startupCwd: options.startupCwd } : {}),
    ...(options?.command ? { pendingStartup: { command: options.command } } : {})
  })
  state.setActiveTabType('terminal', activeWorktreeId)
  // Save visual order with the new terminal last or fallback ordering puts terminals first.
  persistAgentLaunchTabOrder(activeWorktreeId, tabId)
  options?.onSettled?.(true)
}
