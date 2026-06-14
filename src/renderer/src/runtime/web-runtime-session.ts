/* eslint-disable max-lines */
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  BrowserTabCreateResult,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalClose,
  RuntimeTerminalSplit
} from '../../../shared/runtime-types'
import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'
import type { TuiAgent } from '../../../shared/types'
import type { AppState } from '../store/types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'

export {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from './web-terminal-surface-id'

export function isWebRuntimeSessionActive(
  activeRuntimeEnvironmentId: string | null | undefined
): boolean {
  // Why: headless serve sessions are owned by the remote runtime, regardless
  // of whether the attaching client is web or desktop Electron.
  return Boolean(activeRuntimeEnvironmentId?.trim())
}

const pendingWebRuntimeSplitMirrorTelemetry = new Map<string, Set<string>>()
const WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS = 30_000
let pendingWebRuntimeSplitMirrorTelemetryId = 0

export async function createWebRuntimeSessionTerminal(args: {
  worktreeId: string
  environmentId?: string | null
  afterTabId?: string
  targetGroupId?: string
  command?: string
  agent?: TuiAgent
  activate?: boolean
  selectWorktree?: boolean
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  if (args.selectWorktree !== false) {
    selectWebRuntimeSessionWorktree(args.worktreeId)
  }
  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
        targetGroupId: args.targetGroupId,
        command: args.command,
        agent: args.agent,
        activate: args.activate !== false
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>)
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to create terminal:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export async function createWebRuntimeSessionBrowserTab(args: {
  worktreeId: string
  environmentId?: string | null
  url?: string
  profileId?: string | null
  targetGroupId?: string
  selectWorktree?: boolean
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  const shouldSelectWorktree = args.selectWorktree !== false
  const stagedFromWorktreeId = useAppStore.getState().activeWorktreeId
  if (shouldSelectWorktree) {
    selectWebRuntimeSessionWorktree(args.worktreeId)
  }
  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'browser.tabCreate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        url: args.url,
        profileId: args.profileId ?? undefined,
        // Why: paired web clients need the local tab immediately. The remote
        // pane will stream once the host webview registers; waiting here makes
        // the workspace appear to close while the host finishes mounting.
        waitForRegistration: false
      },
      timeoutMs: 15_000
    })
    const created = unwrapRuntimeRpcResult(response as RuntimeRpcResponse<BrowserTabCreateResult>)
    stageWebRuntimeBrowserTab({
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId: created.browserPageId,
      url: args.url,
      targetGroupId: args.targetGroupId,
      restoreFocus:
        shouldSelectWorktree &&
        (stagedFromWorktreeId === args.worktreeId ||
          useAppStore.getState().activeWorktreeId === args.worktreeId)
    })
    void refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to create browser tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

function stageWebRuntimeBrowserTab(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  url?: string
  targetGroupId?: string
  restoreFocus?: boolean
}): void {
  const remotePageId = args.remotePageId.trim()
  if (!remotePageId) {
    return
  }

  const existing = findLocalBrowserPageForRemotePage(
    useAppStore.getState(),
    args.environmentId,
    remotePageId
  )
  if (args.restoreFocus !== false) {
    selectWebRuntimeSessionWorktree(args.worktreeId)
  }

  if (existing) {
    if (args.restoreFocus !== false) {
      useAppStore
        .getState()
        .focusBrowserTabInWorktree(args.worktreeId, existing.pageId, { surfacePane: true })
    }
    return
  }

  const url = args.url?.trim() || 'about:blank'
  // Why: paired web browser tabs are host-owned, but the session snapshot can
  // arrive after React has already rendered a fallback workspace. Stage the
  // remote handle immediately so the current worktree stays selected.
  const browserTab = useAppStore.getState().createBrowserTab(args.worktreeId, url, {
    title: url === 'about:blank' ? 'New Browser Tab' : url,
    focusAddressBar: true,
    browserRuntimeEnvironmentId: args.environmentId,
    targetGroupId: args.targetGroupId
  })
  const pageId = browserTab.activePageId ?? browserTab.pageIds?.[0] ?? null
  if (!pageId) {
    return
  }
  useAppStore.getState().setRemoteBrowserPageHandle(pageId, {
    environmentId: args.environmentId,
    remotePageId
  })
}

function selectWebRuntimeSessionWorktree(worktreeId: string): void {
  useAppStore.getState().setActiveWorktree(worktreeId)
}

function findLocalBrowserPageForRemotePage(
  state: AppState,
  environmentId: string,
  remotePageId: string
): { pageId: string } | null {
  for (const pages of Object.values(state.browserPagesByWorkspace)) {
    for (const page of pages) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle?.environmentId === environmentId && handle.remotePageId === remotePageId) {
        return { pageId: page.id }
      }
    }
  }
  return null
}

async function refreshWebRuntimeSessionTabsSnapshot(
  environmentId: string,
  worktreeId: string
): Promise<void> {
  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'session.tabs.list',
      params: {
        worktree: toRuntimeWorktreeSelector(worktreeId)
      },
      timeoutMs: 15_000
    })
    const snapshot = unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabsResult>
    )
    const { applyFreshWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
    useAppStore.setState((state) => {
      // Why: eager refreshes can resolve after the user has selected another
      // worktree; session parity should update tabs without stealing focus.
      const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId)
      return patch === state ? state : patch
    })
  } catch (error) {
    // Why: browser creation already succeeded on the host. If the eager parity
    // refresh fails, the long-lived session.tabs subscription can still catch up.
    console.warn(
      '[web-runtime-session] failed to refresh browser tab snapshot:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function activateWebRuntimeSessionWorktree(args: {
  worktreeId: string
  environmentId?: string | null
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'worktree.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId)
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to activate worktree:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export async function activateWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
}): Promise<boolean> {
  return callWebRuntimeSessionTabMethod('session.tabs.activate', args)
}

export async function closeWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
}): Promise<boolean> {
  return callWebRuntimeSessionTabMethod('session.tabs.close', args)
}

export async function moveWebRuntimeSessionTab(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
    environmentId?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const { resolveHostSessionTabIdForWebSessionTab } = await import('./web-session-tabs-sync')
    const state = useAppStore.getState()
    const resolveHostBackedTabId = (tabId: string): string | null =>
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId
      }) ?? (isWebTerminalSurfaceTabId(tabId) ? toHostSessionTabId(tabId) : null)
    const toHostTabId = (tabId: string): string => resolveHostBackedTabId(tabId) ?? tabId
    const movedHostTabId =
      args.kind === 'reorder' ? resolveHostBackedTabId(args.tabId) : toHostTabId(args.tabId)
    if (!movedHostTabId) {
      return false
    }
    const reorderedHostTabOrder =
      args.kind === 'reorder'
        ? args.tabOrder
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId))
        : null
    if (reorderedHostTabOrder && !reorderedHostTabOrder.includes(movedHostTabId)) {
      return false
    }
    const targetHostIndex =
      args.kind === 'move-to-group' && typeof args.index === 'number'
        ? (state.groupsByWorktree?.[args.worktreeId]
            ?.find((group) => group.id === args.targetGroupId)
            ?.tabOrder.slice(0, args.index)
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId)).length ?? args.index)
        : args.kind === 'move-to-group'
          ? args.index
          : undefined
    const base = {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: movedHostTabId,
      targetGroupId: args.targetGroupId
    }
    const move =
      args.kind === 'reorder'
        ? {
            ...base,
            kind: 'reorder' as const,
            // Why: paired web groups can contain local-only tabs alongside
            // host-mirrored tabs. The host reorder API only accepts host tab
            // ids, so local ids must be omitted from the mirrored order.
            tabOrder: reorderedHostTabOrder
          }
        : args.kind === 'split'
          ? {
              ...base,
              kind: 'split' as const,
              splitDirection: args.splitDirection
            }
          : {
              ...base,
              kind: 'move-to-group' as const,
              // Why: web groups can contain local-only tabs. Host insertion
              // indexes must be counted in the filtered host-backed order.
              index: targetHostIndex
            }
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'session.tabs.move',
      params: move,
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeMobileSessionTabMoveResult>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to move tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

async function callWebRuntimeSessionTabMethod(
  method: 'session.tabs.activate' | 'session.tabs.close',
  args: {
    worktreeId: string
    tabId: string
    environmentId?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const { resolveHostSessionTabIdForWebSessionTab } = await import('./web-session-tabs-sync')
    const state = useAppStore.getState()
    const hostTabId =
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId: args.tabId
      }) ?? toHostSessionTabId(args.tabId)
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method,
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    if (method === 'session.tabs.close') {
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId)
    }
    return true
  } catch (error) {
    console.warn(
      `[web-runtime-session] failed to ${method === 'session.tabs.close' ? 'close' : 'activate'} tab:`,
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export function splitWebRuntimeTerminal(
  ptyId: string | null | undefined,
  direction: 'horizontal' | 'vertical',
  telemetrySource: TerminalPaneSplitSource
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Why: split requests from the paired web client must run on the host pane.
  // A local split would mint a web-only pane and the host would mirror it back
  // as a separate tab instead of preserving the terminal split layout.
  const pendingMirrorSuppressionId = reservePendingWebRuntimeSplitMirrorTelemetry(ptyId, direction)
  const releasePendingMirrorSuppression = schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
    ptyId,
    direction,
    pendingMirrorSuppressionId
  )
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.split',
      params: {
        terminal: remote.handle,
        direction,
        telemetrySource
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ split: RuntimeTerminalSplit }>)
    })
    .catch((error) => {
      releasePendingMirrorSuppression()
      console.warn(
        '[web-runtime-session] failed to split terminal:',
        error instanceof Error ? error.message : String(error)
      )
    })
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

export function closeWebRuntimeTerminal(ptyId: string | null | undefined): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Why: host-session mirror panes are detached locally in the browser, but
  // the host owns the real pane graph. Close the host terminal first so later
  // session snapshots cannot resurrect the locally removed pane.
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
      console.warn(
        '[web-runtime-session] failed to close terminal pane:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
