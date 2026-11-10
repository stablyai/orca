import { useAppStore } from '@/store/index'
import { assertRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import { openWorkspaceBrowserTab } from '../browser/workspace/workspace-browser-tab-open'
import { isSshDeploymentClientBrowserRoute } from '../browser/workspace/workspace-browser-route-eligibility'
import { resolveWorktreeOperationRoute } from '../workspace/ownership/worktree-operation-route'
import {
  RUNTIME_BROWSER_UNAVAILABLE_MESSAGE,
  getWorkspaceClientCreationActionPolicy,
  runtimeHostsPagesOnThisDesktop
} from '../client-creation-action-policy'

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

// Why: a managed SSH server has no browser of its own, and a paired server can host pages on this
// desktop. Links already use those routes. A port click must not demand screencast first.
function environmentPortOpensOnDesktop(worktreeId: string, environmentId: string): boolean {
  const state = useAppStore.getState()
  const capabilities = state.runtimeStatusByEnvironmentId?.get(environmentId)?.status?.capabilities
  if (capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)) {
    return false
  }
  if (runtimeHostsPagesOnThisDesktop(state, environmentId)) {
    return true
  }
  const availability = getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  return isSshDeploymentClientBrowserRoute(state, availability, route, worktreeId, environmentId)
}

async function openEnvironmentPortOnDesktop(args: {
  worktreeId: string
  environmentId: string
  url: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await openWorkspaceBrowserTab({
      workspaceId: args.worktreeId,
      url: args.url,
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: args.environmentId
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to open browser.' }
  }
}

export async function openEnvironmentWorkspacePortInBrowser(args: {
  worktreeId: string
  url: string
  runtimeTarget: Extract<RuntimeClientTarget, { kind: 'environment' }>
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (environmentPortOpensOnDesktop(args.worktreeId, args.runtimeTarget.environmentId)) {
    return openEnvironmentPortOnDesktop({
      worktreeId: args.worktreeId,
      environmentId: args.runtimeTarget.environmentId,
      url: args.url
    })
  }
  try {
    await assertRuntimeEnvironmentCapability(
      args.runtimeTarget.environmentId,
      BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
      RUNTIME_BROWSER_UNAVAILABLE_MESSAGE
    )
    const remotePage = await callRuntimeRpc<{ browserPageId: string }>(
      args.runtimeTarget,
      'browser.tabCreate',
      { worktree: toRuntimeWorktreeSelector(args.worktreeId), url: args.url },
      { timeoutMs: 30_000 }
    )
    const browserPageId = createBrowserUuid()
    args.createBrowserTab(args.worktreeId, args.url, {
      activate: true,
      browserRuntimeEnvironmentId: args.runtimeTarget.environmentId,
      browserPageId
    })
    args.setRemoteBrowserPageHandle(browserPageId, {
      environmentId: args.runtimeTarget.environmentId,
      remotePageId: remotePage.browserPageId
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to open remote browser.' }
  }
}
