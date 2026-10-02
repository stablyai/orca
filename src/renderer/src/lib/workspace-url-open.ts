import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { useAppStore } from '@/store'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RUNTIME_BROWSER_UNAVAILABLE_MESSAGE } from './client-creation-action-policy'

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

export const WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON =
  'Workspace ports are unavailable for this execution host.'

/** Opens a URL in the system browser or the workspace's Orca browser (remote hosts included). */
export async function openUrlInWorkspaceBrowser(args: {
  url: string
  worktreeId: string | null
  runtimeTarget: RuntimeClientTarget | null
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!args.runtimeTarget) {
    return { ok: false, reason: WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON }
  }
  const { url, worktreeId } = args
  if (args.openInOrcaBrowser === false && args.runtimeTarget.kind === 'local') {
    try {
      await window.api.shell.openUrl(url)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open system browser.' }
    }
  }

  if (!worktreeId) {
    return { ok: false, reason: 'No workspace selected for the browser.' }
  }
  // Why: the browser tab opened below is this jump's surface; seeding a shell would add a
  // PTY the user never asked for in a workspace whose last terminal they closed.
  activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  if (args.runtimeTarget.kind === 'environment') {
    try {
      await assertRuntimeEnvironmentCapability(
        args.runtimeTarget.environmentId,
        BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
        RUNTIME_BROWSER_UNAVAILABLE_MESSAGE
      )
      const remotePage = await callRuntimeRpc<{ browserPageId: string }>(
        args.runtimeTarget,
        'browser.tabCreate',
        { worktree: toRuntimeWorktreeSelector(worktreeId), url },
        { timeoutMs: 30_000 }
      )
      const tab = args.createBrowserTab(worktreeId, url, {
        activate: true,
        browserRuntimeEnvironmentId: args.runtimeTarget.environmentId
      })
      if (!tab.activePageId) {
        return { ok: false, reason: 'Failed to create a browser page.' }
      }
      args.setRemoteBrowserPageHandle(tab.activePageId, {
        environmentId: args.runtimeTarget.environmentId,
        remotePageId: remotePage.browserPageId
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open remote browser.' }
    }
  }
  try {
    args.createBrowserTab(worktreeId, url, { activate: true })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to open browser.' }
  }
}
