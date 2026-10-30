import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { useAppStore } from '@/store'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  WorkspacePort,
  WorkspacePortKillResult,
  WorkspacePortScanResult
} from '../../../shared/workspace-ports'
import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import { runWorkspacePortScanForTarget } from './workspace-port-scan-client'
import { browserUrlForPort } from './workspace-port-urls'
import { createBrowserUuid } from './browser-uuid'
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
  // Shift+Cmd/Ctrl forces external browser; keyboard/context-menu opens without pointer events retain saved settings.
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

/** The URL a port opens at: its labelled localhost name when one is set up locally, else its raw URL. */
export async function resolveWorkspacePortBrowserUrl(args: {
  port: WorkspacePort
  runtimeTarget: RuntimeClientTarget
  localhostLabelRoute?: LocalhostWorktreeLabelRoute | null
}): Promise<string> {
  const rawUrl = browserUrlForPort(args.port)
  if (args.runtimeTarget.kind !== 'local' || !args.localhostLabelRoute) {
    return rawUrl
  }
  try {
    return (await window.api.localhostWorktreeLabels.register(args.localhostLabelRoute)).url
  } catch {
    return rawUrl
  }
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
  const url = await resolveWorkspacePortBrowserUrl({
    port: args.port,
    runtimeTarget: args.runtimeTarget,
    localhostLabelRoute: args.localhostLabelRoute
  })
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
  // The browser is this navigation’s surface; never add an unrequested shell after the last terminal was closed.
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
      const browserPageId = createBrowserUuid()
      args.createBrowserTab(worktreeId, url, {
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
  try {
    args.createBrowserTab(worktreeId, url, { activate: true })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to open browser.' }
  }
}

/** Atomically publish host scan plus aggregate so hosts cannot overwrite each other or notify twice. Keep synthetic aggregate keys out of the per-host map or later merges duplicate rows. */
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
      return {
        ok: false,
        reason:
          message ||
          translate(
            'auto.components.right.sidebar.PortsPanel.740aca88ab',
            'Workspace port scan failed.'
          )
      }
    }
    publishScan(firstScan)

    // SIGTERM can leave listeners briefly visible; rescan after settling. Ignore refresh failure because the first scan already updated UI and stop succeeded.
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
      // Simple scanner IDs (tcp:3000) collide across hosts; qualify aggregate row keys.
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

  // Coalesce same-tick surface refreshes to avoid duplicate lsof/netstat/RPC work.
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
