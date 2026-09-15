import { activateAndRevealWorktree } from './worktree-activation'
import { useAppStore } from '@/store'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import { browserUrlForPort } from './workspace-port-urls'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RUNTIME_BROWSER_UNAVAILABLE_MESSAGE } from './client-creation-action-policy'
import { registerWorkspaceSurfaceProducer } from './workspace-surface-production'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

const WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON =
  'Workspace ports are unavailable for this execution host.'

export async function openWorkspacePortInBrowser(args: {
  port: WorkspacePort
  activeWorktreeId?: string | null
  runtimeTarget: RuntimeClientTarget | null
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
  localhostLabelRoute?: LocalhostWorktreeLabelRoute | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!args.runtimeTarget) {
    return { ok: false, reason: WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON }
  }
  const rawUrl = browserUrlForPort(args.port)
  let url = rawUrl
  if (args.runtimeTarget.kind === 'local' && args.localhostLabelRoute) {
    try {
      url = (await window.api.localhostWorktreeLabels.register(args.localhostLabelRoute)).url
    } catch {
      url = rawUrl
    }
  }
  if (args.openInOrcaBrowser === false && args.runtimeTarget.kind === 'local') {
    try {
      await window.api.shell.openUrl(url)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open system browser.' }
    }
  }

  const worktreeId =
    args.port.kind === 'workspace' ? args.port.owner.worktreeId : args.activeWorktreeId
  if (!worktreeId) {
    return { ok: false, reason: 'No workspace selected for the browser.' }
  }
  const state = useAppStore.getState()
  const executionHostId =
    args.runtimeTarget.kind === 'environment'
      ? toRuntimeExecutionHostId(args.runtimeTarget.environmentId)
      : getExecutionHostIdForWorktree(state, worktreeId)
  const producer = registerWorkspaceSurfaceProducer({ workspaceKey: worktreeId, executionHostId })
  try {
    const activation = activateAndRevealWorktree(worktreeId, { executionHostId })
    if (activation === false) {
      producer.failed('The workspace is no longer available.')
      return { ok: false, reason: 'The workspace is no longer available.' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    producer.failed(message || 'Failed to activate the workspace.')
    return { ok: false, reason: message || 'Failed to activate the workspace.' }
  }
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
        producer.failed('Failed to create a browser page.')
        return { ok: false, reason: 'Failed to create a browser page.' }
      }
      args.setRemoteBrowserPageHandle(tab.activePageId, {
        environmentId: args.runtimeTarget.environmentId,
        remotePageId: remotePage.browserPageId
      })
      producer.materialized({ kind: 'tab', id: tab.id })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      producer.failed(message || 'Failed to open remote browser.')
      return { ok: false, reason: message || 'Failed to open remote browser.' }
    }
  }
  try {
    const tab = args.createBrowserTab(worktreeId, url, { activate: true })
    producer.materialized({ kind: 'tab', id: tab.id })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    producer.failed(message || 'Failed to open browser.')
    return { ok: false, reason: message || 'Failed to open browser.' }
  }
}
