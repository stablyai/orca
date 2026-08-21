import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { useAppStore } from '@/store'
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

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

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

function toFailureReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || fallback
}

async function openInSystemBrowser(
  url: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await window.api.shell.openUrl(url)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: toFailureReason(error, 'Failed to open system browser.') }
  }
}

async function openInEnvironmentBrowser(args: {
  runtimeTarget: RuntimeClientTarget & { kind: 'environment' }
  worktreeId: string
  url: string
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
}): Promise<{ ok: true } | { ok: false; reason: string }> {
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
    const tab = args.createBrowserTab(args.worktreeId, args.url, {
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
    return { ok: false, reason: toFailureReason(error, 'Failed to open remote browser.') }
  }
}

function openInLocalOrcaBrowser(args: {
  worktreeId: string
  url: string
  createBrowserTab: BrowserTabCreator
}): { ok: true } | { ok: false; reason: string } {
  try {
    args.createBrowserTab(args.worktreeId, args.url, { activate: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: toFailureReason(error, 'Failed to open browser.') }
  }
}

export async function openWorkspacePortInBrowser(args: {
  port: WorkspacePort
  activeWorktreeId?: string | null
  runtimeTarget: RuntimeClientTarget
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
  localhostLabelRoute?: LocalhostWorktreeLabelRoute | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
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
    return openInSystemBrowser(url)
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
    return openInEnvironmentBrowser({
      runtimeTarget: args.runtimeTarget,
      worktreeId,
      url,
      createBrowserTab: args.createBrowserTab,
      setRemoteBrowserPageHandle: args.setRemoteBrowserPageHandle
    })
  }
  return openInLocalOrcaBrowser({ worktreeId, url, createBrowserTab: args.createBrowserTab })
}
