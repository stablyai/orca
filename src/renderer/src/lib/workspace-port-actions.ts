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
import { browserUrlForPort } from './workspace-port-urls'

export { addressForPort } from './workspace-port-urls'

const WORKSPACE_PORT_STOP_SETTLE_MS = 500

export function canStopWorkspacePort(
  port: WorkspacePort
): port is WorkspacePort & { kind: 'workspace'; pid: number } {
  return port.kind === 'workspace' && Boolean(port.pid) && port.processName !== 'Electron'
}

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']
type WorkspacePortScanSetter = ReturnType<typeof useAppStore.getState>['setWorkspacePortScan']
type WorkspacePortScanRefreshingSetter = ReturnType<
  typeof useAppStore.getState
>['setWorkspacePortScanRefreshing']

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function shouldOpenWorkspacePortInOrcaBrowser(
  settings: { openLinksInApp?: boolean } | null | undefined
): boolean {
  return settings?.openLinksInApp !== false
}

export function workspacePortOwnerWorktreeId(port: WorkspacePort): string | null {
  return port.kind === 'workspace' ? port.owner.worktreeId : null
}

export function goToWorkspacePortOwner(port: WorkspacePort): boolean {
  const worktreeId = workspacePortOwnerWorktreeId(port)
  return Boolean(worktreeId && activateAndRevealWorktree(worktreeId))
}

export async function openWorkspacePortInBrowser(args: {
  port: WorkspacePort
  activeWorktreeId?: string | null
  runtimeTarget: RuntimeClientTarget
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = browserUrlForPort(args.port)
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

export async function refreshWorkspacePortScanState(args: {
  runtimeTarget: RuntimeClientTarget
  setWorkspacePortScan: WorkspacePortScanSetter
  setWorkspacePortScanRefreshing: WorkspacePortScanRefreshingSetter
}): Promise<WorkspacePortScanResult> {
  args.setWorkspacePortScanRefreshing(true)
  try {
    const scan = await scanWorkspacePortsForTarget(args.runtimeTarget)
    args.setWorkspacePortScan({
      key: `${workspacePortRuntimeTargetKey(args.runtimeTarget)}:all`,
      result: scan
    })
    return scan
  } finally {
    args.setWorkspacePortScanRefreshing(false)
  }
}

export async function refreshWorkspacePortScanAfterStop(args: {
  runtimeTarget: RuntimeClientTarget
  setWorkspacePortScan: WorkspacePortScanSetter
  setWorkspacePortScanRefreshing: WorkspacePortScanRefreshingSetter
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  args.setWorkspacePortScanRefreshing(true)
  try {
    let firstScan: WorkspacePortScanResult
    try {
      firstScan = await scanWorkspacePortsForTarget(args.runtimeTarget)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Workspace port scan failed.' }
    }
    args.setWorkspacePortScan({
      key: `${workspacePortRuntimeTargetKey(args.runtimeTarget)}:all`,
      result: firstScan
    })

    // Why: stopping sends SIGTERM, and the listener can remain visible for a
    // short window. A settled re-scan keeps worktree cards from showing a stale
    // port row after the process actually exits. Failures here are swallowed
    // because the UI is already correct from the first scan; surfacing a
    // 'Failed to refresh ports' toast on top of the stop success would lie.
    await delay(WORKSPACE_PORT_STOP_SETTLE_MS)
    try {
      const settledScan = await scanWorkspacePortsForTarget(args.runtimeTarget)
      args.setWorkspacePortScan({
        key: `${workspacePortRuntimeTargetKey(args.runtimeTarget)}:all`,
        result: settledScan
      })
    } catch {
      // Intentionally ignored: first scan already updated the UI.
    }
    return { ok: true }
  } finally {
    args.setWorkspacePortScanRefreshing(false)
  }
}

export function workspacePortRuntimeTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

const inFlightWorkspacePortScans = new Map<string, Promise<WorkspacePortScanResult>>()

function workspacePortScanRequestKey(target: RuntimeClientTarget, repoId?: string): string {
  return JSON.stringify([workspacePortRuntimeTargetKey(target), repoId ?? null])
}

async function runWorkspacePortScanForTarget(
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

export async function scanWorkspacePortsForTarget(
  target: RuntimeClientTarget,
  repoId?: string
): Promise<WorkspacePortScanResult> {
  const key = workspacePortScanRequestKey(target, repoId)
  const existing = inFlightWorkspacePortScans.get(key)
  if (existing) {
    return existing
  }

  // Why: visible surfaces can request the same scan on the same tick
  // (focus refresh, status bar, side panel, stop refresh). Share it so one
  // UI burst cannot fan out into duplicate lsof/netstat/RPC work.
  const promise = runWorkspacePortScanForTarget(target, repoId).finally(() => {
    if (inFlightWorkspacePortScans.get(key) === promise) {
      inFlightWorkspacePortScans.delete(key)
    }
  })
  inFlightWorkspacePortScans.set(key, promise)
  return promise
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
