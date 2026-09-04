import { useAppStore } from '@/store'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import type { ExecutionHostId } from '../../../../shared/execution-host'

/**
 * Mount a session the grid just created without activating its workspace, so
 * the pty spawns while the user stays on the grid — the card previews it as
 * soon as the store reports the pty live. This is what the launch menu passes
 * as `onLaunched` in place of the tab bar's focus handoff.
 */
export function mountSessionGridLaunchInBackground(worktreeId: string, tabId: string): void {
  requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
}

/**
 * Open a plain shell session in a workspace from the grid, on the host the user picked
 * when the surface offered one row per host.
 *
 * `activate: false` is what makes it a background launch: `createTab` activates by default
 * and moves the GLOBAL `activeTabId`, so the user would come back from the grid standing in
 * a terminal they never asked to open.
 */
export function launchSessionGridTab(worktreeId: string, executionHostId?: ExecutionHostId): void {
  const createdTabId =
    useAppStore.getState().createTab(worktreeId, undefined, undefined, {
      activate: false,
      ...(executionHostId ? { executionHostId } : {})
    })?.id ?? null
  if (createdTabId) {
    mountSessionGridLaunchInBackground(worktreeId, createdTabId)
  }
}
