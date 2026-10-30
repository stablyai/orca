import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  type RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '../store'
import { getRuntimeEnvironmentConnectionGeneration } from '../store/slices/runtime-status-connection-generation'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import {
  peekWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { isServerFrameDrawnWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { isWebSessionTabsWorktreeRemovalFrame } from './web-session-tabs-sync/session-tabs-inventory-absence'

/** The pane last reported per connection and workspace. Reporting again only when the desktop's own
 *  pane changes keeps two windows sharing one device id from steering the pick back and forth. */
const reportedPaneByWorkspace = new Map<string, string>()
/** Each workspace's latest frame, so opening a workspace can report without waiting for a new one. */
const latestFrameByWorkspace = new Map<
  string,
  {
    environmentId: string
    snapshot: RuntimeMobileSessionTabsResult
    /** The pairing and connection the frame came over; a later one cannot speak for it. */
    generation: string
  }
>()
const pendingCheckByWorkspace = new Map<string, ReturnType<typeof setTimeout>>()
/** Bumped by mirror teardown, so a report answered after it does nothing. */
const teardownEpochByEnvironment = new Map<string, number>()
let stopWatchingActiveWorkspace: (() => void) | null = null

/** A tab click records its activation only after an async hop; settle before comparing so a
 *  report can never race the user's own pick to the server. */
export const VISIBLE_TAB_PICK_SETTLE_MS = 1500

function connectionGeneration(environmentId: string): string {
  return `${captureWebSessionIntentOwner(environmentId).pairingRevision}\0${getRuntimeEnvironmentConnectionGeneration(environmentId)}`
}

// One outstanding check per workspace reads the latest frame when it fires, so a busy workspace's
// stream of frames cannot keep postponing it.
function scheduleCheck(frameKey: string): void {
  if (pendingCheckByWorkspace.has(frameKey)) {
    return
  }
  pendingCheckByWorkspace.set(
    frameKey,
    setTimeout(() => {
      pendingCheckByWorkspace.delete(frameKey)
      const frame = latestFrameByWorkspace.get(frameKey)
      if (!frame) {
        return
      }
      if (frame.generation !== connectionGeneration(frame.environmentId)) {
        latestFrameByWorkspace.delete(frameKey)
        return
      }
      reportIfStale(frame.environmentId, frame.snapshot)
    }, VISIBLE_TAB_PICK_SETTLE_MS)
  )
}

function watchActiveWorkspace(): void {
  stopWatchingActiveWorkspace ??= useAppStore.subscribe((state, previous) => {
    if (!state.activeWorktreeId || state.activeWorktreeId === previous.activeWorktreeId) {
      return
    }
    for (const [frameKey, frame] of latestFrameByWorkspace) {
      if (frame.snapshot.worktree === state.activeWorktreeId) {
        scheduleCheck(frameKey)
      }
    }
  })
}

/**
 * The server remembers each device's tab per workspace and hands it back whenever the desktop has
 * no tab groups of its own for that workspace (first open, or a saved session that lost them). A
 * desktop that kept its own groups never told the server what it showed, so that memory went stale
 * and such an open landed on the wrong tab. Report the visible terminal pane when they differ.
 */
export function reportVisibleTabPickToHost(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const frameKey = `${environmentId}\0${snapshot.worktree}`
  // Only servers that keep a pick per device project it; an older one would move the host instead.
  // A removal frame has nothing to pick, and caching it would outlive the workspace.
  if (
    !snapshot.publicationEpoch.endsWith(CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX) ||
    isWebSessionTabsWorktreeRemovalFrame(snapshot)
  ) {
    latestFrameByWorkspace.delete(frameKey)
    return
  }
  latestFrameByWorkspace.set(frameKey, {
    environmentId,
    snapshot,
    generation: connectionGeneration(environmentId)
  })
  watchActiveWorkspace()
  scheduleCheck(frameKey)
}

function reportIfStale(environmentId: string, snapshot: RuntimeMobileSessionTabsResult): void {
  const worktreeId = snapshot.worktree
  const owner = captureWebSessionIntentOwner(environmentId)
  if (
    !isWebRuntimeSessionActive(environmentId) ||
    isServerFrameDrawnWorkspace(environmentId, worktreeId) ||
    peekWebSessionFocusIntent(owner, worktreeId)
  ) {
    return
  }
  const state = useAppStore.getState()
  // Only the workspace on screen: its pane attaches anyway, so a report can never start a terminal
  // the user isn't looking at. Without groups of its own the desktop shows the server's pick.
  if (
    state.activeWorktreeId !== worktreeId ||
    // Two paired servers can publish the same workspace id; only its owner hears about it.
    runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId) !== environmentId ||
    (state.groupsByWorktree[worktreeId] ?? []).length === 0
  ) {
    return
  }
  const visible = visibleTerminalPane(worktreeId)
  if (!visible) {
    return
  }
  const { hostTabId, leafId: localLeafId } = visible
  // Name the exact pane: the server remembers a pane, not just a tab.
  const target = snapshot.tabs.find(
    (tab) =>
      tab.type === 'terminal' &&
      tab.parentTabId === hostTabId &&
      (!localLeafId || tab.leafId === localLeafId)
  )
  if (target?.type !== 'terminal') {
    return
  }
  const key = `${environmentId}\0${worktreeId}`
  // The connection is part of the value, so a new pairing or connection reports afresh.
  const pane = `${connectionGeneration(environmentId)}\0${hostTabId}\0${target.leafId}`
  if (snapshot.activeTabId === target.id) {
    // In agreement: remember it, so a later change of this desktop's pane reports again.
    reportedPaneByWorkspace.set(key, pane)
    return
  }
  // A pending pane would be started by activation; its own attach handles that.
  if (target.status !== 'ready' || reportedPaneByWorkspace.get(key) === pane) {
    return
  }
  reportedPaneByWorkspace.set(key, pane)
  const reportedLeafId = target.leafId
  const sentEpoch = teardownEpochByEnvironment.get(environmentId) ?? 0
  const sentGeneration = connectionGeneration(environmentId)
  const stillCurrent = (): boolean =>
    (teardownEpochByEnvironment.get(environmentId) ?? 0) === sentEpoch &&
    connectionGeneration(environmentId) === sentGeneration
  const retryLater = (): void => {
    if (reportedPaneByWorkspace.get(key) === pane) {
      reportedPaneByWorkspace.delete(key)
    }
  }
  void captureRuntimeEnvironmentCall(
    environmentId,
    owner.pairingRevision
  )({
    method: 'session.tabs.activate',
    params: {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      tabId: hostTabId,
      leafId: target.leafId,
      notifyClients: false,
      navigation: 'caller',
      intent: 'automatic'
    },
    timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
  }).then(
    (response) => settle(response.ok ? { result: response.result } : null),
    () => settle(null)
  )

  // Any outcome, even a timeout, may have landed after a newer pick by the user: the host does
  // not order activations. Reconcile with what the desktop shows now.
  function settle(answer: { result: unknown } | null): void {
    if (!stillCurrent()) {
      return
    }
    if (!answer) {
      // Tried again on a later frame.
      retryLater()
    }
    const now = visibleTerminalPane(worktreeId)
    if (!now) {
      reassertVisibleNonTerminalTab(worktreeId, stillCurrent)
      return
    }
    if (now.hostTabId === hostTabId && (!now.leafId || now.leafId === reportedLeafId)) {
      return
    }
    // A record or cached frame may predate the late landing; the host's answer, when there is
    // one, is its state after this report.
    reportedPaneByWorkspace.delete(key)
    if (answer && isSessionTabsFrame(answer.result, worktreeId)) {
      latestFrameByWorkspace.set(key, {
        environmentId,
        snapshot: answer.result,
        generation: sentGeneration
      })
    }
    scheduleCheck(key)
  }
}

/** A browser or chat tab the user picked while a report was in flight: send their pick again, the
 *  way a click does, so the report cannot have the last word. */
function reassertVisibleNonTerminalTab(worktreeId: string, stillCurrent: () => boolean): void {
  const state = useAppStore.getState()
  const visibleId = resolveWebSessionVisibleTabId(state, worktreeId)
  const visible = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === visibleId)
  if (visible?.contentType !== 'browser' && visible?.contentType !== 'agent-session') {
    return
  }
  const next = { type: visible.contentType, id: visible.entityId, tabId: visible.id }
  // Loaded lazily: the owner activations reach the session-tab lifecycle, which loads this module.
  void import('../lib/cycled-tab-owner-activation').then(({ activateCycledTabOnOwner }) => {
    if (stillCurrent()) {
      activateCycledTabOnOwner(worktreeId, next)
    }
  })
}

/** The activate answer is the host's per-device frame after the report. */
function isSessionTabsFrame(
  value: unknown,
  worktreeId: string
): value is RuntimeMobileSessionTabsResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktree' in value &&
    value.worktree === worktreeId &&
    'publicationEpoch' in value &&
    typeof value.publicationEpoch === 'string' &&
    value.publicationEpoch.endsWith(CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX) &&
    'tabs' in value &&
    Array.isArray(value.tabs)
  )
}

/** The terminal pane the desktop shows in a workspace, by the host's tab id. */
function visibleTerminalPane(
  worktreeId: string
): { hostTabId: string; leafId: string | undefined } | null {
  const state = useAppStore.getState()
  const visibleId = resolveWebSessionVisibleTabId(state, worktreeId)
  const visible = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === visibleId)
  if (visible?.contentType !== 'terminal' || !isWebTerminalSurfaceTabId(visible.entityId)) {
    return null
  }
  return {
    hostTabId: toHostSessionTabId(visible.entityId),
    leafId: state.terminalLayoutsByTabId[visible.entityId]?.activeLeafId ?? undefined
  }
}

function forgetVisibleTabPicks(matches: (frameKey: string) => boolean): void {
  for (const map of [reportedPaneByWorkspace, latestFrameByWorkspace]) {
    for (const key of map.keys()) {
      if (matches(key)) {
        map.delete(key)
      }
    }
  }
  for (const [key, timer] of pendingCheckByWorkspace) {
    if (matches(key)) {
      clearTimeout(timer)
      pendingCheckByWorkspace.delete(key)
    }
  }
}

/** Mirror teardown for an environment drops everything recorded for it. */
export function forgetVisibleTabPicksForEnvironment(environmentId: string): void {
  teardownEpochByEnvironment.set(
    environmentId,
    (teardownEpochByEnvironment.get(environmentId) ?? 0) + 1
  )
  const prefix = `${environmentId}\0`
  forgetVisibleTabPicks((key) => key.startsWith(prefix))
}

/** A removed workspace drops its record, so later workspace switches never scan it. */
export function forgetVisibleTabPicksForWorktree(environmentId: string, worktreeId: string): void {
  const frameKey = `${environmentId}\0${worktreeId}`
  forgetVisibleTabPicks((key) => key === frameKey)
}

export function resetReportedVisibleTabPicksForTests(): void {
  reportedPaneByWorkspace.clear()
  latestFrameByWorkspace.clear()
  for (const timer of pendingCheckByWorkspace.values()) {
    clearTimeout(timer)
  }
  pendingCheckByWorkspace.clear()
  stopWatchingActiveWorkspace?.()
  stopWatchingActiveWorkspace = null
}
