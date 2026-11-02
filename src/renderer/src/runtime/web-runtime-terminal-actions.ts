import { toast } from 'sonner'
import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeTerminalClose, RuntimeTerminalSplit } from '../../../shared/runtime-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { isServerFrameDrawnWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { redrawServerLayoutWorkspace } from './server-layout-apply-routes'
import {
  beginWebRuntimeSplitFocusRequest,
  captureWebRuntimeSplitFocusTarget,
  finishWebRuntimeSplitFocusRequest,
  focusSplitWebRuntimeTerminalPane,
  type WebRuntimeSplitSource
} from './web-runtime-split-focus'

const pendingWebRuntimeSplitMirrorTelemetry = new Map<string, Set<string>>()
const WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS = 30_000
let pendingWebRuntimeSplitMirrorTelemetryId = 0

export function splitWebRuntimeTerminal(
  ptyId: string | null | undefined,
  direction: 'horizontal' | 'vertical',
  telemetrySource: TerminalPaneSplitSource,
  source?: WebRuntimeSplitSource
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Split on the host pane; local splits mint web-only panes the host mirrors as separate tabs.
  const pendingMirrorSuppressionId = reservePendingWebRuntimeSplitMirrorTelemetry(ptyId, direction)
  const releasePendingMirrorSuppression = schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
    ptyId,
    direction,
    pendingMirrorSuppressionId
  )
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const focusTarget = source ? captureWebRuntimeSplitFocusTarget(ptyId, source) : null
  // Advance the fence for every source-bearing gesture, even when its pane metadata is stale.
  const focusRequest = source
    ? beginWebRuntimeSplitFocusRequest(intentOwner, source.worktreeId)
    : null
  void captureRuntimeEnvironmentCall(
    environmentId,
    intentOwner.pairingRevision
  )({
    method: 'terminal.split',
    params: {
      terminal: remote.handle,
      direction,
      telemetrySource
    },
    timeoutMs: 15_000
  })
    .then(async (response) => {
      const result = unwrapRuntimeRpcResult(
        response as RuntimeRpcResponse<{ split: RuntimeTerminalSplit }>
      )
      await focusSplitWebRuntimeTerminalPane(intentOwner, focusTarget, focusRequest, result?.split)
    })
    .catch((error) => {
      releasePendingMirrorSuppression()
      const message = error instanceof Error ? error.message : String(error)
      // Report failed splits visibly or the requested pane silently never appears.
      toast.error(message)
      console.warn('[web-runtime-session] failed to split terminal:', message)
    })
    .finally(() => finishWebRuntimeSplitFocusRequest(focusRequest))
  return true
}

export function consumePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string | null | undefined,
  direction: 'horizontal' | 'vertical'
): boolean {
  if (!sourcePtyId) {
    return false
  }
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key)
  const id = ids?.values().next().value
  if (!ids || !id) {
    return false
  }
  ids.delete(id)
  if (ids.size === 0) {
    pendingWebRuntimeSplitMirrorTelemetry.delete(key)
  }
  return true
}

function reservePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical'
): string {
  const id = String(++pendingWebRuntimeSplitMirrorTelemetryId)
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key) ?? new Set<string>()
  ids.add(id)
  pendingWebRuntimeSplitMirrorTelemetry.set(key, ids)
  return id
}

function schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical',
  id: string
): () => void {
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    releasePendingWebRuntimeSplitMirrorTelemetry(sourcePtyId, direction, id)
  }
  const timeout = globalThis.setTimeout(release, WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS)
  return () => {
    globalThis.clearTimeout(timeout)
    release()
  }
}

function releasePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical',
  id: string
): void {
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key)
  if (!ids) {
    return
  }
  ids.delete(id)
  if (ids.size === 0) {
    pendingWebRuntimeSplitMirrorTelemetry.delete(key)
  }
}

function getPendingWebRuntimeSplitMirrorTelemetryKey(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical'
): string {
  return `${direction}:${sourcePtyId}`
}

/** `worktreeId`: the pane's workspace, whose server frames redraw a pane the server kept. */
export function closeWebRuntimeTerminal(
  ptyId: string | null | undefined,
  worktreeId?: string
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Close host terminal first or later authoritative snapshots resurrect the pane.
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.close',
      params: {
        terminal: remote.handle
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ close: RuntimeTerminalClose }>)
    })
    .catch((error) => {
      // Switch point: the window already dropped the pane; the server's frames draw what it kept.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && worktreeId) {
        redrawServerLayoutWorkspace(environmentId, worktreeId)
      }
      console.warn(
        '[web-runtime-session] failed to close terminal pane:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}

// Push remote geometry to its host or the next authoritative snapshot reverts it.
export async function updateWebRuntimePaneLayout(args: {
  worktreeId: string
  tabId: string
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  chatLeafId?: string | null
  titlesByLeafId?: Record<string, string>
  renamedLeafIds?: string[]
}): Promise<boolean> {
  // Why: a twin's edit must not reach either host on a guess; it stays local until one is chosen.
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    args.worktreeId,
    'push a pane layout to its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  // Frame-drawn geometry uses layout.apply (sizes, moves, chat pane); only rename still needs this push.
  if (!args.renamedLeafIds?.length && isServerFrameDrawnWorkspace(environmentId, args.worktreeId)) {
    return true
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  const hostTabId = isWebTerminalSurfaceTabId(args.tabId)
    ? toHostSessionTabId(args.tabId)
    : args.tabId
  try {
    const response = await callEnvironment({
      method: 'session.tabs.updatePaneLayout',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        root: args.root,
        expandedLeafId: args.expandedLeafId,
        ...(args.chatLeafId !== undefined ? { chatLeafId: args.chatLeafId } : {}),
        ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {}),
        ...(args.renamedLeafIds ? { renamedLeafIds: args.renamedLeafIds } : {})
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ updated: true }>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to update pane layout:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

// Push color/pin to the authoritative host for persistence; undefined means unchanged.
export function setWebRuntimeTabProps(args: {
  worktreeId: string
  tabId: string
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  customTitle?: string | null
}): boolean {
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    args.worktreeId,
    'push tab props to its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  const state = useAppStore.getState()
  void import('./web-session-tabs-sync/tracking-mappings')
    .then(({ resolveHostSessionTabIdForWebSessionTab }) => {
      const hostTabId =
        resolveHostSessionTabIdForWebSessionTab(state, {
          environmentId,
          worktreeId: args.worktreeId,
          tabId: args.tabId
        }) ?? (isWebTerminalSurfaceTabId(args.tabId) ? toHostSessionTabId(args.tabId) : args.tabId)
      return callEnvironment({
        method: 'session.tabs.setTabProps',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          tabId: hostTabId,
          ...(args.color !== undefined ? { color: args.color } : {}),
          ...(args.isPinned !== undefined ? { isPinned: args.isPinned } : {}),
          ...(args.viewMode !== undefined ? { viewMode: args.viewMode } : {}),
          ...(args.customTitle !== undefined ? { customTitle: args.customTitle } : {})
        },
        timeoutMs: 15_000
      })
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ updated: true }>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to set tab props:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
