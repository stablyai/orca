import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { useAppStore } from '@/store'
import {
  callRuntimeRpc,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import type {
  WorkspacePort,
  WorkspacePortKillResult,
  WorkspacePortScanResult
} from '../../../shared/workspace-ports'

// Why: the scanner reports numeric addresses (127.0.0.1, 0.0.0.0, ::1, ::)
// while UI actions should use an address a browser can reliably open.
function hostForLocalAction(host: string): string {
  if (!host) {
    return 'localhost'
  }
  return host.includes(':') ? `[${host}]` : host
}

export function addressForPort(port: WorkspacePort): string {
  return `${hostForLocalAction(port.connectHost)}:${port.port}`
}

export function browserUrlForPort(port: WorkspacePort): string {
  const protocol = port.protocol === 'https' ? 'https' : 'http'
  return `${protocol}://${addressForPort(port)}`
}

export function canStopWorkspacePort(
  port: WorkspacePort
): port is WorkspacePort & { kind: 'workspace'; pid: number } {
  return port.kind === 'workspace' && Boolean(port.pid) && port.processName !== 'Electron'
}

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

export async function openWorkspacePortInBrowser(args: {
  port: WorkspacePort
  activeWorktreeId?: string | null
  runtimeTarget: RuntimeClientTarget
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const worktreeId =
    args.port.kind === 'workspace' ? args.port.owner.worktreeId : args.activeWorktreeId
  if (!worktreeId) {
    return { ok: false, reason: 'No workspace selected for the browser.' }
  }
  const url = browserUrlForPort(args.port)
  activateAndRevealWorktree(worktreeId)
  if (args.runtimeTarget.kind === 'environment') {
    try {
      const remotePage = await callRuntimeRpc<{ browserPageId: string }>(
        args.runtimeTarget,
        'browser.tabCreate',
        { worktree: `id:${worktreeId}`, url },
        { timeoutMs: 30_000 }
      )
      const tab = args.createBrowserTab(worktreeId, url, { activate: true })
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
  args.createBrowserTab(worktreeId, url, { activate: true })
  return { ok: true }
}

export function workspacePortRuntimeTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export async function scanWorkspacePortsForTarget(
  target: RuntimeClientTarget,
  repoId?: string
): Promise<WorkspacePortScanResult> {
  const params = repoId ? { repoId } : {}
  if (target.kind === 'local') {
    return window.api.workspacePorts.scan(params)
  }
  try {
    return await callRuntimeRpc<WorkspacePortScanResult>(target, 'workspacePorts.scan', params, {
      timeoutMs: 15_000
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return {
        platform: 'unknown',
        scannedAt: Date.now(),
        ports: [],
        unavailableReason: 'The connected runtime does not support workspace port management yet.'
      }
    }
    throw error
  }
}

export async function killWorkspacePortForTarget(
  target: RuntimeClientTarget,
  args: { repoId: string; pid: number; port: number }
): Promise<WorkspacePortKillResult> {
  if (target.kind === 'local') {
    return window.api.workspacePorts.kill(args)
  }
  try {
    return await callRuntimeRpc<WorkspacePortKillResult>(target, 'workspacePorts.kill', args, {
      timeoutMs: 15_000
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return {
        ok: false,
        reason: 'The connected runtime does not support workspace port management yet.'
      }
    }
    throw error
  }
}
