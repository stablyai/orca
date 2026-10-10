import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { useAppStore } from '@/store'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  WorkspacePort,
  WorkspacePortKillResult,
  WorkspacePortScanResult
} from '../../../shared/workspace-ports'
import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import { runWorkspacePortScanForTarget } from './workspace-port-scan-client'
import { browserUrlForPort } from './workspace-port-urls'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RUNTIME_BROWSER_UNAVAILABLE_MESSAGE } from './client-creation-action-policy'

export { addressForPort } from './workspace-port-urls'

const WORKSPACE_PORT_STOP_SETTLE_MS = 500
const WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON =
  'Workspace ports are unavailable for this execution host.'

/** Projection key for the merged multi-host view; never a per-host scan key. */
export const WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY = 'all-hosts:all'

export function canStopWorkspacePort(
  port: WorkspacePort
): port is WorkspacePort & { kind: 'workspace'; pid: number } {
  return port.kind === 'workspace' && Boolean(port.pid) && port.processName !== 'Electron'
}

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']
type WorkspacePortScanRefreshingSetter = ReturnType<
  typeof useAppStore.getState
>['setWorkspacePortScanRefreshing']
type ReplaceWorkspacePortScansSetter = ReturnType<
  typeof useAppStore.getState
>['replaceWorkspacePortScans']

export type WorkspacePortScanPublisher = {
  replaceWorkspacePortScans: ReplaceWorkspacePortScansSetter
  getWorkspacePortScansByKey: () => Record<string, WorkspacePortScanResult>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function shouldOpenWorkspacePortInOrcaBrowser(
  settings: { openLinksInApp?: boolean } | null | undefined
): boolean {
  return settings?.openLinksInApp === true
}

function isMacShortcutPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function getPortSystemBrowserHint(isMac: boolean = isMacShortcutPlatform()): string {
  return isMac ? '⇧⌘+click for system browser' : 'Shift+Ctrl+click for system browser'
}

export function getPortOpenBrowserTooltipLabel(openLabel: string, isMac?: boolean): string {
  return `${openLabel}. ${getPortSystemBrowserHint(isMac)}`
}

type PortOpenClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export function resolvePortOpenInOrcaBrowser({
  settings,
  event,
  isMac
}: {
  settings: { openLinksInApp?: boolean } | null | undefined
  event?: PortOpenClickEvent | null
  isMac: boolean
}): boolean {
  // Why: Shift+Cmd/Ctrl is the external-browser escape hatch; no pointer
  // event means context-menu and keyboard opens should keep the saved setting.
  if (event?.shiftKey && (isMac ? event.metaKey : event.ctrlKey)) {
    return false
  }
  return shouldOpenWorkspacePortInOrcaBrowser(settings)
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

/**
 * Stores one host's scan and republishes the aggregate the status bar reads.
 * Why: a single-host publish used to overwrite that aggregate, so every other
 * host's ports vanished from the count until the next background poll. One
 * replaceWorkspacePortScans update (not setWorkspacePortScan) keeps the synthetic
 * all-hosts key out of workspacePortScansByKey, where re-merging it would
 * duplicate rows — and notifies subscribers once instead of twice for one scan.
 */
export function publishWorkspacePortScanForHost(
  args: WorkspacePortScanPublisher & { scanKey: string; scan: WorkspacePortScanResult }
): void {
  const scansByKey = { ...args.getWorkspacePortScansByKey(), [args.scanKey]: args.scan }
  const merged = mergeWorkspacePortScans(scansByKey)
  args.replaceWorkspacePortScans(scansByKey, {
    key: Object.keys(scansByKey).length > 1 ? WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY : args.scanKey,
    result: merged ?? args.scan
  })
}

/** Re-scans one host after a port stop (immediately, then settled) and republishes the aggregate. */
export async function refreshWorkspacePortScanAfterStop(
  args: WorkspacePortScanPublisher & {
    runtimeTarget: RuntimeClientTarget | null
    setWorkspacePortScanRefreshing: WorkspacePortScanRefreshingSetter
  }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!args.runtimeTarget) {
    return { ok: false, reason: WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON }
  }
  const scanKey = workspacePortScanKeyForTarget(args.runtimeTarget)
  const publishScan = (scan: WorkspacePortScanResult): void => {
    publishWorkspacePortScanForHost({ ...args, scanKey, scan })
  }
  args.setWorkspacePortScanRefreshing(true)
  try {
    let firstScan: WorkspacePortScanResult
    try {
      firstScan = await scanWorkspacePortsForTarget(args.runtimeTarget)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Workspace port scan failed.' }
    }
    publishScan(firstScan)

    // Why: stopping sends SIGTERM, and the listener can remain visible for a
    // short window. A settled re-scan keeps worktree cards from showing a stale
    // port row after the process actually exits. Failures here are swallowed
    // because the UI is already correct from the first scan; surfacing a
    // 'Failed to refresh ports' toast on top of the stop success would lie.
    await delay(WORKSPACE_PORT_STOP_SETTLE_MS)
    try {
      const settledScan = await scanWorkspacePortsForTarget(args.runtimeTarget)
      publishScan(settledScan)
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

export function workspacePortScanKeyForTarget(target: RuntimeClientTarget): string {
  return `${workspacePortRuntimeTargetKey(target)}:all`
}

export function mergeWorkspacePortScans(
  scansByKey: Record<string, WorkspacePortScanResult>
): WorkspacePortScanResult | null {
  const entries = Object.entries(scansByKey)
    .filter(([, scan]) => scan)
    .sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) {
    return null
  }
  if (entries.length === 1) {
    return entries[0][1]
  }
  const ports = entries.flatMap(([key, scan]) =>
    scan.ports.map((port) => ({
      ...port,
      // Why: local and runtime scanners can both report simple ids like
      // `tcp:3000`; aggregate All-hosts views need stable unique row keys.
      id: `${key}:${port.id}`
    }))
  )
  const unavailable = entries
    .map(([key, scan]) => (scan.unavailableReason ? `${key}: ${scan.unavailableReason}` : null))
    .filter((entry): entry is string => entry !== null)
  return {
    platform: 'unknown',
    scannedAt: Math.max(...entries.map(([, scan]) => scan.scannedAt)),
    ports,
    ...(unavailable.length === entries.length && unavailable.length > 0
      ? { unavailableReason: unavailable.join('; ') }
      : {})
  }
}

const inFlightWorkspacePortScans = new Map<string, Promise<WorkspacePortScanResult>>()

function workspacePortScanRequestKey(target: RuntimeClientTarget, repoId?: string): string {
  return JSON.stringify([workspacePortRuntimeTargetKey(target), repoId ?? null])
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
  target: RuntimeClientTarget | null,
  args: { repoId: string; pid: number; port: number }
): Promise<WorkspacePortKillResult> {
  if (!target) {
    return { ok: false, reason: WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON }
  }
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
