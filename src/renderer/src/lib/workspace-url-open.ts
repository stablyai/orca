import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeTargetForExecutionHostId } from '@/runtime/runtime-client-target'
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

/** Opens a URL in the system browser or the workspace's Orca browser (remote hosts included). */
export async function openUrlInWorkspaceBrowser(args: {
  url: string
  worktreeId: string | null
  runtimeTarget: RuntimeClientTarget | null
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Why: direct-SSH owners have no runtime target; a saved link still opens in the local browser.
  const runtimeTarget = args.runtimeTarget ?? { kind: 'local' as const }
  const { url, worktreeId } = args
  if (args.openInOrcaBrowser === false && runtimeTarget.kind === 'local') {
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
  if (runtimeTarget.kind === 'environment') {
    try {
      await assertRuntimeEnvironmentCapability(
        runtimeTarget.environmentId,
        BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
        RUNTIME_BROWSER_UNAVAILABLE_MESSAGE
      )
      const remotePage = await callRuntimeRpc<{ browserPageId: string }>(
        runtimeTarget,
        'browser.tabCreate',
        { worktree: toRuntimeWorktreeSelector(worktreeId), url },
        { timeoutMs: 30_000 }
      )
      const tab = args.createBrowserTab(worktreeId, url, {
        activate: true,
        browserRuntimeEnvironmentId: runtimeTarget.environmentId
      })
      if (!tab.activePageId) {
        return { ok: false, reason: 'Failed to create a browser page.' }
      }
      args.setRemoteBrowserPageHandle(tab.activePageId, {
        environmentId: runtimeTarget.environmentId,
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

/** Shortcut path: opens a workspace's saved link in Orca's own browser. */
export function openWorkspaceUrlInOrcaBrowser(worktreeId: string, url: string): void {
  const store = useAppStore.getState()
  void openUrlInWorkspaceBrowser({
    url,
    worktreeId,
    runtimeTarget: runtimeTargetForExecutionHostId(
      getExecutionHostIdForWorktree(store, worktreeId)
    ),
    createBrowserTab: store.createBrowserTab,
    setRemoteBrowserPageHandle: store.setRemoteBrowserPageHandle,
    openInOrcaBrowser: true
  }).then((result) => {
    if (!result.ok) {
      toast.error(
        translate('auto.components.sidebar.WorktreeCardPorts.d1113f4660', 'Failed to open browser'),
        { description: result.reason }
      )
    }
  })
}

export function getActiveWorkspaceUrl(): { worktreeId: string; url: string } | null {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  const url = worktreeId
    ? store.getKnownWorktreeById(worktreeId, store.activeWorkspaceExecutionHostId ?? undefined)
        ?.workspaceUrl
    : undefined
  return worktreeId && url ? { worktreeId, url } : null
}
