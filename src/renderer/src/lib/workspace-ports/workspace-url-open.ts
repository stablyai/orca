import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store/index'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { canOpenWorkspaceBrowserTabOnRuntime } from '@/lib/browser/workspace/workspace-browser-route-eligibility'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/rpc/targets/runtime-client-target'
import { assertRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import { RUNTIME_BROWSER_UNAVAILABLE_MESSAGE } from '../workspace/creation/surface-policy/client-creation-action-policy'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { portSystemBrowserOpener } from './server-port-forward-open'

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

// Why: servers without a browser engine (managed SSH, desktop-hosted pages) open links here; ports must too.
function opensRuntimePortOnThisDesktop(worktreeId: string, environmentId: string): boolean {
  const state = useAppStore.getState()
  const capabilities = readRuntimeStatuses().get(environmentId)?.status?.capabilities
  return (
    !capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY) &&
    canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, environmentId)
  )
}

/** Opens a URL in the system browser or the workspace's Orca browser (remote hosts included). */
export async function openUrlInWorkspaceBrowser(args: {
  url: string
  worktreeId: string | null
  runtimeTarget: RuntimeClientTarget | null
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
  /** Workspace the URL's port belongs to for system-browser forwarding; null for a server's own listeners. Defaults to `worktreeId`. */
  portOwnerWorktreeId?: string | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Why: direct-SSH owners have no runtime target; a saved link still opens in the local browser.
  const runtimeTarget = args.runtimeTarget ?? { kind: 'local' as const }
  const { url, worktreeId } = args
  const openInSystemBrowser =
    args.openInOrcaBrowser === false
      ? portSystemBrowserOpener(
          url,
          runtimeTarget,
          args.portOwnerWorktreeId === undefined ? worktreeId : args.portOwnerWorktreeId
        )
      : null
  if (openInSystemBrowser) {
    try {
      await openInSystemBrowser()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open system browser.' }
    }
  }

  if (!worktreeId) {
    return { ok: false, reason: 'No workspace selected for the browser.' }
  }
  // The browser is this navigation’s surface; never add an unrequested shell after the last terminal was closed.
  activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  if (runtimeTarget.kind === 'environment') {
    try {
      if (opensRuntimePortOnThisDesktop(worktreeId, runtimeTarget.environmentId)) {
        await openWorkspaceBrowserTab({
          workspaceId: worktreeId,
          url,
          intent: { kind: 'url' },
          expectedRuntimeEnvironmentId: runtimeTarget.environmentId
        })
        return { ok: true }
      }
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
      const browserPageId = createBrowserUuid()
      args.createBrowserTab(worktreeId, url, {
        activate: true,
        browserRuntimeEnvironmentId: runtimeTarget.environmentId,
        browserPageId
      })
      args.setRemoteBrowserPageHandle(browserPageId, {
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
    runtimeTarget: runtimeRpcTargetForAuthorityKey(
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
