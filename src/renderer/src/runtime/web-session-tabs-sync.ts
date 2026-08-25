/* eslint-disable max-lines -- web session-tab sync reconciles terminal, unified-tab, group, and PTY maps atomically to avoid split-brain tab state */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AppState } from '../store'
import { useAppStore } from '../store'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  pickParsedAgentStatusPayload,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { agentEntryCompletionAt } from '../../../shared/agent-completion-time'
import { normalizeTurnCompletedAtField } from '../../../shared/agent-status-field-normalization'
import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type {
  BrowserCertificateFailure,
  BrowserPage,
  BrowserWorkspace
} from '../../../shared/browser-workspace-types'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { OpenFile } from '../store/slices/editor'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import {
  buildRetiredTerminalTabStateSweepPatch,
  type RetiredTerminalTabSweepState
} from '../store/slices/retired-terminal-tab-state-sweep'
import { getRemoteRuntimePtyEnvironmentId, toRemoteRuntimePtyId } from './runtime-terminal-stream'
import { sanitizeTerminalLayoutPaneTitlesForLabels } from '@/lib/terminal-pane-title-sanitization'
import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'
import { normalizeTerminalLayoutPtyOwnership } from '@/components/terminal-pane/terminal-layout-pty-ownership'
import { isClientAuthoritativeAgentStatusPane } from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  clearHostSessionMirrorHydration,
  markHostSessionMirrorHydrated,
  markHostSessionMirrorWorktreeHydrated
} from './host-session-mirror-hydration'
import {
  createWebRuntimeSessionTerminal,
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from './web-runtime-session'
import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner
} from '../../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import { resolveTerminalLayoutRoot } from './remote-terminal-layout-resolution'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionFocusIntent,
  clearWebSessionFocusIntentsForOwner,
  peekWebSessionFocusIntent,
  resolveWebSessionSiblingVisibleTabId,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import {
  clearWebSessionCloseIntentsForOwner,
  clearWebSessionCloseIntentsForWorktree,
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents
} from './web-session-close-intent'
import {
  clearWebSessionReorderIntentsForOwner,
  clearWebSessionReorderIntentsForWorktree,
  resolveWebSessionReorderedOrder
} from './web-session-reorder-intent'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearAllWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForWorktree,
  endWebRuntimeWakeTerminalRespawn,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { queueAcceptedWebSessionTerminalSnapshot } from './web-session-terminal-handle-events'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'
import {
  clearWebAgentSessionHandoff,
  clearWebAgentSessionHandoffsForEnvironment,
  clearWebAgentSessionHandoffsForWorktree,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed,
  resolveWebAgentSessionHandoff
} from './web-agent-session-handoff'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { useRuntimeSessionMirrorEnvironmentKey } from './use-runtime-session-mirror-environment-key'
import {
  installWindowVisibilitySubscriptionParking,
  type WindowVisibilitySubscriptionSpec
} from './window-visibility-subscription-parking'
import {
  clearWebSessionBrowserPlacementsForEnvironment,
  clearWebSessionBrowserPlacementsForWorktree,
  isWebSessionBrowserPlacementGroupReserved,
  peekWebSessionBrowserPlacementGroup,
  resetWebSessionBrowserPlacementsForTests
} from './web-session-browser-placement'
import { suppressE2eWebRuntimeBrowserSnapshot } from './web-runtime-browser-creation-e2e-fault'
import { observeAgentHookCompletionForNotification } from '@/hooks/agent-hook-completion-notifications'
import {
  buildWebSessionExistingTabIndex,
  type WebSessionExistingTabIndex
} from './web-session-existing-tab-index'

const WEB_SESSION_GROUP_PREFIX = 'web-session-tabs:'
export const WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS = 100

type SessionTabsStreamEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
  | { type: 'end' }

type SessionTabsListAllResult = {
  snapshots: RuntimeMobileSessionTabsResult[]
}

type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

type ReceivedSessionTabsSnapshot = SnapshotFreshness & {
  receivedFrame: number
}

type SessionTabsRecoveryState = {
  pendingCount: number
}

type SessionTabsRemovalFence = {
  receivedFrame: number
  recoveryState: SessionTabsRecoveryState
  pendingCount: number
}

type TrackedWebSessionTabsWorktree = {
  worktree: string
  freshness: SnapshotFreshness
}

type VisibilityResumeOmission = {
  baseline: SnapshotFreshness
  environmentId: string
  inventoryReceivedFrame: number
  superseded: boolean
  visibilityGeneration: number
}

const latestSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()
const replayableSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()
const latestReceivedSessionTabsSnapshotByWorktree = new Map<string, ReceivedSessionTabsSnapshot>()
const latestSessionTabsRemovalFenceByWorktree = new Map<string, SessionTabsRemovalFence>()
const sessionTabsRecoveryStateByWorktree = new Map<string, SessionTabsRecoveryState>()
const trackedSessionTabsWorktreeIdsByEnvironment = new Map<string, Set<string>>()
const sessionTabsEnvironmentsByWorktree = new Map<string, Set<string>>()
const lastHostTerminalTabCountByWorktree = new Map<string, number>()
const hostSessionTabIdByLocalKey = new Map<string, string>()
const hostSessionTabMappingKeysByEnvironmentAndWorktree = new Map<
  string,
  Map<string, Set<string>>
>()
// Why: a delayed host stamp belongs to the client boundary seen with its preceding ordered frame.
const hostWorkingClientBoundaryByPaneKey = new Map<
  string,
  {
    hostStateStartedAt: number
    hostPrompt: string
    clientStateStartedAt: number
    stamped: boolean
  }
>()
const HOST_WORKING_CLIENT_BOUNDARY_LIMIT = 512
let receivedSessionTabsFrameSequence = 0

type TerminalSurface = RuntimeMobileSessionTerminalClientTab
type ReadyTerminalSurface = RuntimeMobileSessionTerminalClientTab & { status: 'ready' }
type ReadyBrowserSurface = RuntimeMobileSessionBrowserTab & { browserPageId: string }
type ReadyEditorSurface = RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab

type MirroredTerminalTab = {
  tab: TerminalTab
  hostTabId: string
  ptyIds: string[]
  layout: TerminalLayoutSnapshot
  retainedSurfaceByPrunedLeafId?: ReadonlyMap<string, TerminalSurface>
}

type MirroredBrowserTab = {
  workspace: BrowserWorkspace
  page: BrowserPage
  certificateFailure: BrowserCertificateFailure | null
  remotePageId: string
  unifiedTab: Tab
  hostTabId: string
  clientGroupId?: string
}

type MirroredEditorTab = {
  file: OpenFile
  unifiedTab: Tab
  hostTabId: string
}

export type WebSessionTabsSyncState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeBrowserTabIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'browserPagesByWorkspace'
  | 'browserCertificateFailuresByPageId'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'ptyIdsByTabId'
  | 'remoteBrowserPageHandlesByPageId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'
  | 'sortEpoch'
> &
  Partial<
    Pick<
      AppState,
      | 'acknowledgedAgentsByPaneKey'
      | 'agentLaunchConfigByPaneKey'
      | 'automaticAgentResumeClaimsByTabId'
      | 'migrationUnsupportedByPtyId'
      | 'paneForegroundAgentByPaneKey'
      | 'pendingStartupByTabId'
      | 'recentlyClosedAgentStatusTabIds'
      | 'recentlyRetiredAgentStatusPaneKeys'
      | 'retainedAgentsByPaneKey'
      | 'retentionSuppressedPaneKeys'
    >
  >

type WebSessionTabsBatchRecordKey =
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'agentStatusByPaneKey'
  | 'automaticAgentResumeClaimsByTabId'
  | 'browserCertificateFailuresByPageId'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'pendingStartupByTabId'
  | 'ptyIdsByTabId'
  | 'remoteBrowserPageHandlesByPageId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'

/** Open files bucketed by worktree. A snapshot only reconciles its own worktree, so a
 *  batch can decide there is nothing to do without walking every open file in the app.
 *  `source` pins the array it describes; each rebuild updates it in place instead of
 *  re-bucketing, so a batch never pays for the whole array twice. */
type WebSessionOpenFilesIndex = {
  source: readonly OpenFile[]
  byWorktree: Map<string, OpenFile[]>
}

type WebSessionTabsBatchContext = {
  agentPaneKeysByTabId: Map<string, Set<string>> | null
  changedRecords: Set<WebSessionTabsBatchRecordKey>
  openFilesIndex: WebSessionOpenFilesIndex | null
}

function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
}

function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

function advancesSessionTabsFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  baseline: SnapshotFreshness
): boolean {
  return (
    snapshot.publicationEpoch !== baseline.publicationEpoch ||
    snapshot.snapshotVersion > baseline.snapshotVersion
  )
}

function getTrackedWebSessionTabsWorktrees(environmentId: string): TrackedWebSessionTabsWorktree[] {
  return [...(trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? [])].flatMap(
    (worktree) => {
      const key = sessionTabsFreshnessKey(environmentId, worktree)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      return freshness
        ? [
            {
              worktree,
              freshness
            }
          ]
        : []
    }
  )
}

function trackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? new Set()
  worktrees.add(worktreeId)
  trackedSessionTabsWorktreeIdsByEnvironment.set(environmentId, worktrees)
}

function untrackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId)
  if (!worktrees) {
    return
  }
  worktrees.delete(worktreeId)
  if (worktrees.size === 0) {
    trackedSessionTabsWorktreeIdsByEnvironment.delete(environmentId)
  }
}

function recordReceivedWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): number {
  const receivedFrame = (receivedSessionTabsFrameSequence += 1)
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  latestReceivedSessionTabsSnapshotByWorktree.set(key, {
    receivedFrame,
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion
  })
  if ((snapshot as { removed?: unknown }).removed === true) {
    recordReceivedWebSessionTabsRemoval(environmentId, snapshot.worktree, receivedFrame)
  }
  return receivedFrame
}

function recordReceivedWebSessionTabsInventory(): number {
  return (receivedSessionTabsFrameSequence += 1)
}

function beginWebSessionTabsSnapshotRecovery(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number
): () => void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const recoveryState = sessionTabsRecoveryStateByWorktree.get(key) ?? { pendingCount: 0 }
  recoveryState.pendingCount += 1
  sessionTabsRecoveryStateByWorktree.set(key, recoveryState)
  let settled = false
  return () => {
    if (settled) {
      return
    }
    settled = true
    recoveryState.pendingCount -= 1
    if (
      recoveryState.pendingCount === 0 &&
      sessionTabsRecoveryStateByWorktree.get(key) === recoveryState
    ) {
      sessionTabsRecoveryStateByWorktree.delete(key)
    }
    const removalFence = latestSessionTabsRemovalFenceByWorktree.get(key)
    if (
      removalFence?.recoveryState === recoveryState &&
      receivedFrame < removalFence.receivedFrame
    ) {
      removalFence.pendingCount -= 1
      if (removalFence.pendingCount === 0) {
        latestSessionTabsRemovalFenceByWorktree.delete(key)
      }
    }
  }
}

function recordReceivedWebSessionTabsRemoval(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const current = latestSessionTabsRemovalFenceByWorktree.get(key)
  if (current && current.receivedFrame >= receivedFrame) {
    return
  }
  const recoveryState = sessionTabsRecoveryStateByWorktree.get(key)
  if (!recoveryState || recoveryState.pendingCount === 0) {
    latestSessionTabsRemovalFenceByWorktree.delete(key)
    return
  }
  latestSessionTabsRemovalFenceByWorktree.set(key, {
    receivedFrame,
    recoveryState,
    pendingCount: recoveryState.pendingCount
  })
}

function shouldApplyRecoveredWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const removalFrame = latestSessionTabsRemovalFenceByWorktree.get(key)?.receivedFrame
  if (removalFrame !== undefined && receivedFrame < removalFrame) {
    return false
  }
  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  if (!latest || latest.receivedFrame === receivedFrame) {
    return latest !== undefined
  }
  if (latest.publicationEpoch !== snapshot.publicationEpoch) {
    return receivedFrame > latest.receivedFrame
  }
  return snapshot.snapshotVersion >= latest.snapshotVersion
}

function isTrackedWebSessionTabsOmissionCurrent(
  environmentId: string,
  trackedWorktree: TrackedWebSessionTabsWorktree
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, trackedWorktree.worktree)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  return (
    current?.publicationEpoch === trackedWorktree.freshness.publicationEpoch &&
    current.snapshotVersion === trackedWorktree.freshness.snapshotVersion
  )
}

function recordAcceptedWebSessionTabsEnvironment(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(snapshot.worktree) ?? [])
  if (snapshot.tabs.length > 0) {
    environments.add(environmentId)
  } else {
    environments.delete(environmentId)
  }
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(snapshot.worktree, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(snapshot.worktree)
  }
}

function removeWebSessionTabsEnvironment(environmentId: string, worktreeId: string): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? [])
  environments.delete(environmentId)
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(worktreeId, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(worktreeId)
  }
}

const VISIBILITY_INVENTORY_REMOVAL_EPOCH = 'visibility-inventory-removal'

// Why: a tombstone empties the whole worktree mirror — including tabs a still-live sibling environment publishes — so it is a
// visibility fact, never evidence that the host closed anything.
function isWebSessionTabsWorktreeRemovalFrame(snapshot: RuntimeMobileSessionTabsResult): boolean {
  return (
    (snapshot as { removed?: unknown }).removed === true ||
    snapshot.publicationEpoch === VISIBILITY_INVENTORY_REMOVAL_EPOCH
  )
}

// Why: omission means removal only because `listAllMobileSessionTabs` publishes every worktree it knows unfiltered; if a host ever
// scopes that map, this turns live worktrees into tombstones, so the fence below is deliberately short-lived.
function buildMissingWebSessionTabsRemovals(
  environmentId: string,
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[],
  publishedWorktrees: ReadonlySet<string>
): {
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
}[] {
  return trackedWorktrees
    .filter(
      (trackedWorktree) =>
        !publishedWorktrees.has(trackedWorktree.worktree) &&
        isTrackedWebSessionTabsOmissionCurrent(environmentId, trackedWorktree)
    )
    .map((trackedWorktree) => ({
      trackedWorktree,
      snapshot: {
        worktree: trackedWorktree.worktree,
        publicationEpoch: VISIBILITY_INVENTORY_REMOVAL_EPOCH,
        snapshotVersion: 0,
        removed: true,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    }))
}

function rememberHostTerminalTabCount(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}

export function getLastKnownHostTerminalTabCount(
  environmentId: string,
  worktreeId: string
): number {
  return (
    lastHostTerminalTabCountByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId)) ?? 0
  )
}

export function getLatestWebSessionTabsPublicationEpoch(
  environmentId: string,
  worktreeId: string
): string | null {
  return (
    latestSessionTabsSnapshotByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId))
      ?.publicationEpoch ?? null
  )
}

// Why: a replay may repeat the current epoch/version; permit only that exact
// identity once so an older concurrent frame cannot bypass monotonic ordering.
export function acceptReplayedWebSessionTabsSnapshot(
  environmentId: string,
  worktreeId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  if (current) {
    replayableSessionTabsSnapshotByWorktree.set(key, current)
  }
}

/**
 * A frame's fate, paired with whether that fate is host evidence for the
 * worktree — the mirror latch reads the pair, never a bare boolean.
 *
 * Settling on a REJECTED frame is correct only when the store already holds an
 * equal-or-newer accepted view of that worktree, so every rejection branch has
 * to state its answer here. A `false` that meant "the mirror never writes this workspace"
 * would otherwise read as staleness and drain parked resume work — the sweep
 * would treat an undecidable pane as decidable and fork a live agent.
 */
export type WebSessionTabsSnapshotDecision = {
  readonly apply: boolean
  readonly settlesHostMirror: boolean
}

/** The frame's own store patch carries the verdict. */
const WEB_SESSION_TABS_FRAME_APPLIED = {
  apply: true,
  settlesHostMirror: true
} as const satisfies WebSessionTabsSnapshotDecision

/** Outranked by an equal-or-newer accepted view: the host HAS answered here. */
const WEB_SESSION_TABS_FRAME_OUTRANKED = {
  apply: false,
  settlesHostMirror: true
} as const satisfies WebSessionTabsSnapshotDecision

/** Discarded because the mirror never writes this workspace at all, so no
 *  accepted view backs the rejection and the pane stays unaccounted for. */
const WEB_SESSION_TABS_FRAME_UNMIRRORED = {
  apply: false,
  settlesHostMirror: false
} as const satisfies WebSessionTabsSnapshotDecision

/** Why: the floating workspace is a local synthetic terminal the mirror never
 *  writes, so its frames are no evidence about any mirrored pane. */
function isHostMirroredWorktree(worktreeId: string): boolean {
  return worktreeId !== FLOATING_TERMINAL_WORKTREE_ID
}

export function shouldApplyWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): boolean {
  return decideWebSessionTabsSnapshot(snapshot, environmentId).apply
}

export function decideWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): WebSessionTabsSnapshotDecision {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if ((snapshot as { removed?: unknown }).removed === true) {
    // Why: removed worktrees can stop publishing, so clean up their tracking now instead of waiting for a replacement snapshot that may never arrive.
    clearWebSessionTabsTrackingForWorktree(environmentId, snapshot.worktree)
    queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
    return WEB_SESSION_TABS_FRAME_APPLIED
  }
  if (!isHostMirroredWorktree(snapshot.worktree)) {
    // Why: a remote empty same-id snapshot would delete the user's local floating tabs.
    return WEB_SESSION_TABS_FRAME_UNMIRRORED
  }
  rememberHostTerminalTabCount(environmentId, snapshot)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  const replayable = replayableSessionTabsSnapshotByWorktree.get(key)
  const isExactCurrentReplay = Boolean(
    current &&
    replayable &&
    current.publicationEpoch === replayable.publicationEpoch &&
    current.snapshotVersion === replayable.snapshotVersion &&
    snapshot.publicationEpoch === replayable.publicationEpoch &&
    snapshot.snapshotVersion === replayable.snapshotVersion
  )
  // Why: reject stale snapshots only within an epoch; host restarts create a new epoch.
  if (
    current &&
    current.publicationEpoch === snapshot.publicationEpoch &&
    snapshot.snapshotVersion <= current.snapshotVersion &&
    !isExactCurrentReplay
  ) {
    return WEB_SESSION_TABS_FRAME_OUTRANKED
  }
  replayableSessionTabsSnapshotByWorktree.delete(key)
  latestSessionTabsSnapshotByWorktree.set(key, {
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion
  })
  trackWebSessionTabsWorktree(environmentId, snapshot.worktree)
  recordAcceptedWebSessionTabsEnvironment(environmentId, snapshot)
  // Why: a mounted mirror that exhausted bounded polling needs fresh host evidence without subscribing to every store write.
  queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
  return WEB_SESSION_TABS_FRAME_APPLIED
}

export function shouldBootstrapInitialWebRuntimeTerminal(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedInitialTerminal: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
}): boolean {
  return (
    args.snapshotIsFresh &&
    args.event.type === 'snapshot' &&
    args.event.tabs.length === 0 &&
    args.localTerminalCount === 0 &&
    !args.requestedInitialTerminal &&
    args.activeWorktreeId === args.event.worktree
  )
}

export function shouldRespawnWebRuntimeTerminalAfterWake(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedRespawnAfterWake: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
  hasLiveLocalPty: boolean
  skipWakeRespawn?: boolean
}): boolean {
  if (
    !args.snapshotIsFresh ||
    args.requestedRespawnAfterWake ||
    args.skipWakeRespawn === true ||
    args.localTerminalCount === 0 ||
    args.hasLiveLocalPty ||
    (args.event.type !== 'snapshot' && args.event.type !== 'updated')
  ) {
    return false
  }
  if (args.activeWorktreeId !== args.event.worktree) {
    return false
  }
  const hostTerminalTabCount = args.event.tabs.filter((tab) => tab.type === 'terminal').length
  return hostTerminalTabCount === 0
}

export function shouldSyncRuntimeSessionTabs(args: {
  activeWorktreeId?: string | null
  activeWorktreeRuntimeEnvironmentId?: string | null
  workspaceSessionReady: boolean
}): boolean {
  const environmentId = args.activeWorktreeRuntimeEnvironmentId?.trim()
  if (!environmentId || !args.workspaceSessionReady) {
    return false
  }
  return Boolean(args.activeWorktreeId?.trim())
}

export function shouldSyncAllRuntimeSessionTabs(args: {
  activeRuntimeEnvironmentId: string | null | undefined
  workspaceSessionReady: boolean
}): boolean {
  const environmentId = args.activeRuntimeEnvironmentId?.trim()
  return Boolean(environmentId && args.workspaceSessionReady)
}

export function resetWebSessionTabsSnapshotFreshnessForTests(): void {
  latestSessionTabsSnapshotByWorktree.clear()
  replayableSessionTabsSnapshotByWorktree.clear()
  latestReceivedSessionTabsSnapshotByWorktree.clear()
  latestSessionTabsRemovalFenceByWorktree.clear()
  sessionTabsRecoveryStateByWorktree.clear()
  trackedSessionTabsWorktreeIdsByEnvironment.clear()
  sessionTabsEnvironmentsByWorktree.clear()
  receivedSessionTabsFrameSequence = 0
  lastHostTerminalTabCountByWorktree.clear()
  hostSessionTabIdByLocalKey.clear()
  hostSessionTabMappingKeysByEnvironmentAndWorktree.clear()
  hostWorkingClientBoundaryByPaneKey.clear()
  resetWebSessionBrowserPlacementsForTests()
}

export function _getWebSessionTabsTrackingCountsForTest(): {
  freshness: number
  hostMappings: number
  hostMappingWorktrees: number
} {
  let hostMappingWorktrees = 0
  for (const mappingKeysByWorktree of hostSessionTabMappingKeysByEnvironmentAndWorktree.values()) {
    hostMappingWorktrees += mappingKeysByWorktree.size
  }
  return {
    freshness: latestSessionTabsSnapshotByWorktree.size,
    hostMappings: hostSessionTabIdByLocalKey.size,
    // Why: the mapping index is a parallel structure, so leak tests must see it drain alongside the flat map.
    hostMappingWorktrees
  }
}

export function _getWebSessionTabsRecoveryTrackingCountsForTest(): {
  pendingRecoveries: number
  removalFrames: number
} {
  return {
    pendingRecoveries: sessionTabsRecoveryStateByWorktree.size,
    removalFrames: latestSessionTabsRemovalFenceByWorktree.size
  }
}

function clearWebSessionTabsTrackingForWorktree(environmentId: string, worktreeId: string): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  latestSessionTabsSnapshotByWorktree.delete(key)
  replayableSessionTabsSnapshotByWorktree.delete(key)
  latestReceivedSessionTabsSnapshotByWorktree.delete(key)
  untrackWebSessionTabsWorktree(environmentId, worktreeId)
  removeWebSessionTabsEnvironment(environmentId, worktreeId)
  lastHostTerminalTabCountByWorktree.delete(key)
  clearWebRuntimeWakeTerminalRespawnForWorktree(worktreeId)
  clearWebSessionReorderIntentsForWorktree({ environmentId }, worktreeId)
  clearWebSessionCloseIntentsForWorktree({ environmentId }, worktreeId)
  clearWebAgentSessionHandoffsForWorktree(environmentId, worktreeId)
  clearHostSessionTabIdMappings(environmentId, worktreeId)
  clearWebSessionBrowserPlacementsForWorktree(environmentId, worktreeId)
}

export function clearWebSessionTabsTrackingForEnvironment(environmentId: string): void {
  const trimmedEnvironmentId = environmentId.trim()
  if (!trimmedEnvironmentId) {
    return
  }
  const keyPrefix = `${trimmedEnvironmentId}:`
  for (const key of latestSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of replayableSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      replayableSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of latestReceivedSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestReceivedSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of latestSessionTabsRemovalFenceByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsRemovalFenceByWorktree.delete(key)
    }
  }
  for (const key of sessionTabsRecoveryStateByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      sessionTabsRecoveryStateByWorktree.delete(key)
    }
  }
  trackedSessionTabsWorktreeIdsByEnvironment.delete(trimmedEnvironmentId)
  for (const worktreeId of sessionTabsEnvironmentsByWorktree.keys()) {
    removeWebSessionTabsEnvironment(trimmedEnvironmentId, worktreeId)
  }
  for (const key of lastHostTerminalTabCountByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      lastHostTerminalTabCountByWorktree.delete(key)
    }
  }
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(trimmedEnvironmentId)
  if (mappingKeysByWorktree) {
    for (const mappingKeys of mappingKeysByWorktree.values()) {
      for (const mappingKey of mappingKeys) {
        hostSessionTabIdByLocalKey.delete(mappingKey)
      }
    }
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(trimmedEnvironmentId)
  }
  clearWebAgentSessionHandoffsForEnvironment(trimmedEnvironmentId)
  clearWebSessionBrowserPlacementsForEnvironment(trimmedEnvironmentId)
  clearHostSessionMirrorHydration(trimmedEnvironmentId)
  clearAllWebRuntimeWakeTerminalRespawn()
}

function hostSessionTabMappingKey(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string {
  return `${args.environmentId}:${args.worktreeId}:${args.tabId}`
}

function clearHostSessionTabIdMappings(environmentId: string, worktreeId: string): void {
  const mappingKeysByWorktree = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)
  const mappingKeys = mappingKeysByWorktree?.get(worktreeId)
  if (!mappingKeys) {
    return
  }
  for (const mappingKey of mappingKeys) {
    hostSessionTabIdByLocalKey.delete(mappingKey)
  }
  mappingKeysByWorktree?.delete(worktreeId)
  if (mappingKeysByWorktree?.size === 0) {
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(environmentId)
  }
}

function setHostSessionTabIdMapping(
  args: { environmentId: string; worktreeId: string; tabId: string },
  hostTabId: string
): void {
  const mappingKey = hostSessionTabMappingKey(args)
  hostSessionTabIdByLocalKey.set(mappingKey, hostTabId)
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(args.environmentId) ?? new Map()
  const mappingKeys = mappingKeysByWorktree.get(args.worktreeId) ?? new Set<string>()
  mappingKeys.add(mappingKey)
  mappingKeysByWorktree.set(args.worktreeId, mappingKeys)
  hostSessionTabMappingKeysByEnvironmentAndWorktree.set(args.environmentId, mappingKeysByWorktree)
}

export function resolveHostSessionTabIdForWebSessionTab(
  _state: WebSessionTabsSyncState,
  args: {
    environmentId: string
    worktreeId: string
    tabId: string
  }
): string | null {
  return (
    hostSessionTabIdByLocalKey.get(hostSessionTabMappingKey(args)) ??
    // Why: structured create returns canonical identity before its confirming
    // snapshot; an immediate user close must already target that host tab.
    resolveWebAgentSessionHandoff({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      provisionalTabId: args.tabId
    })
  )
}

function isReadyTerminalTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyTerminalSurface {
  return tab.type === 'terminal' && tab.status === 'ready' && tab.terminal.trim().length > 0
}

function isTerminalSurfaceTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is TerminalSurface {
  return tab.type === 'terminal'
}

function isReadyBrowserTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyBrowserSurface {
  return tab.type === 'browser' && typeof tab.browserPageId === 'string' && tab.browserPageId !== ''
}

function isReadyEditorTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyEditorSurface {
  return tab.type === 'markdown' || tab.type === 'file'
}

function localEditorFileId(tab: ReadyEditorSurface): string {
  if (tab.type === 'markdown' && tab.mode === 'markdown-preview') {
    return `markdown-preview::${tab.sourceFilePath}`
  }
  return tab.filePath
}

function editorSourceFileId(tab: ReadyEditorSurface): string | undefined {
  return tab.type === 'markdown' && tab.mode === 'markdown-preview' ? tab.sourceFilePath : undefined
}

function isRuntimeTerminalTabForEnvironment(tab: TerminalTab, environmentId: string): boolean {
  if (!tab.ptyId) {
    return false
  }
  return getRemoteRuntimePtyEnvironmentId(tab.ptyId) === environmentId
}

function isMirroredTerminalSurfaceId(tabId: string): boolean {
  return (
    tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX) ||
    tabId.includes(HOST_TERMINAL_SURFACE_SEPARATOR)
  )
}

function chooseRemoteTerminalLayout(
  surfaces: readonly TerminalSurface[],
  ptyIdsByLeafId: Record<string, string>,
  existingLayout?: TerminalLayoutSnapshot,
  requestedActiveLeafId?: string
): TerminalLayoutSnapshot {
  const leafIds = surfaces.map((surface) => surface.leafId)
  const knownLeafIds = new Set(leafIds)
  const parentLayoutSource = surfaces.find((surface) => surface.parentLayout)
  const parentLayout = parentLayoutSource?.parentLayout
    ? sanitizeTerminalLayoutPaneTitlesForLabels(parentLayoutSource.parentLayout, [
        parentLayoutSource.title
      ])
    : undefined
  const activeLeafId =
    (requestedActiveLeafId && knownLeafIds.has(requestedActiveLeafId)
      ? requestedActiveLeafId
      : null) ??
    // Why: host title/status snapshots may still mark an agent pane active after this client selected a different split pane.
    (existingLayout?.activeLeafId && knownLeafIds.has(existingLayout.activeLeafId)
      ? existingLayout.activeLeafId
      : null) ??
    (parentLayout?.activeLeafId && knownLeafIds.has(parentLayout.activeLeafId)
      ? parentLayout.activeLeafId
      : null) ??
    surfaces.find((surface) => surface.isActive)?.leafId ??
    leafIds[0] ??
    null
  const expandedLeafId =
    requestedActiveLeafId &&
    (Boolean(existingLayout?.expandedLeafId) || Boolean(parentLayout?.expandedLeafId))
      ? requestedActiveLeafId
      : parentLayout?.expandedLeafId && knownLeafIds.has(parentLayout.expandedLeafId)
        ? parentLayout.expandedLeafId
        : null
  return {
    // Why: host parentLayout is authoritative for split direction; else keep the prior client tree, then degenerate — never re-guess a direction.
    root: resolveTerminalLayoutRoot({
      authoritativeRoot: parentLayout?.root,
      existingRoot: existingLayout?.root,
      leafIds,
      onSynthesize: (leafCount) =>
        console.warn(
          `[web-session-tabs-sync] synthesized layout for ${leafCount} leaves; no authoritative or prior tree covered them`
        )
    }),
    activeLeafId,
    expandedLeafId,
    ptyIdsByLeafId,
    // Why: surface.title is the tab/PTY label, not a pane title; restoring it as one renders a fake title bar. Only host layout titles are real pane titles.
    ...(parentLayout?.titlesByLeafId ? { titlesByLeafId: parentLayout.titlesByLeafId } : {})
  }
}

function shouldReplaceTerminalTab(
  tab: TerminalTab,
  environmentId: string,
  nextRemotePtyIds: ReadonlySet<string>,
  nextMirroredTerminalIds: ReadonlySet<string>,
  exactProvisionalHandoffs: ReadonlySet<string>
): boolean {
  if (exactProvisionalHandoffs.has(tab.id)) {
    // Why: agent kind is not session identity; retire only the provisional tab
    // whose request or structured response identifies this exact host surface.
    return true
  }
  if (isMirroredTerminalSurfaceId(tab.id)) {
    // Why: host snapshots are authoritative for mirrored tabs; replace old mirrors even when the next surface still awaits a stream handle, else parity drifts.
    return true
  }
  if (tab.pendingActivationSpawn && tab.ptyId === null && nextRemotePtyIds.size > 0) {
    return true
  }
  if (!isRuntimeTerminalTabForEnvironment(tab, environmentId)) {
    return false
  }
  // Why: web-created remote tabs use local UUIDs until the host publishes their surface; only retire them once their PTY appears in the snapshot.
  return (
    tab.ptyId !== null &&
    (nextRemotePtyIds.has(tab.ptyId) ||
      nextMirroredTerminalIds.has(toWebTerminalSurfaceTabId(tab.id)))
  )
}

/** Constructs mirrored terminal tabs from the mobile session status payload, normalising Pi-compatible agent titles under launch ownership. */
function buildMirroredTerminalTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  existingById: ReadonlyMap<string, TerminalTab>,
  existingLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot>>,
  sortOffset: number,
  now: number,
  focusTarget?: { parentTabId: string; leafId: string }
): MirroredTerminalTab[] {
  const groups = new Map<string, TerminalSurface[]>()
  for (const tab of snapshot.tabs.filter(isTerminalSurfaceTab)) {
    const group = groups.get(tab.parentTabId) ?? []
    group.push(tab)
    groups.set(tab.parentTabId, group)
  }

  return [...groups.entries()].map(([parentTabId, surfaces], index) => {
    const localTabId = toWebTerminalSurfaceTabId(parentTabId)
    const existingLayout = existingLayoutsByTabId[localTabId]
    const requestedActiveLeafId =
      focusTarget?.parentTabId === parentTabId ? focusTarget.leafId : undefined
    const activeSurface =
      (requestedActiveLeafId
        ? surfaces.find((surface) => surface.leafId === requestedActiveLeafId)
        : undefined) ??
      (existingLayout?.activeLeafId
        ? surfaces.find((surface) => surface.leafId === existingLayout.activeLeafId)
        : undefined) ??
      surfaces.find((surface) => surface.isActive) ??
      surfaces[0]!
    const ptyIdsByLeafId = Object.fromEntries(
      surfaces
        .filter((surface): surface is ReadyTerminalSurface => surface.status === 'ready')
        .map((surface) => [surface.leafId, toRemoteRuntimePtyId(surface.terminal, environmentId)])
    )
    const layout = normalizeTerminalLayoutPtyOwnership(
      chooseRemoteTerminalLayout(surfaces, ptyIdsByLeafId, existingLayout, requestedActiveLeafId)
    ).snapshot
    const layoutPtyEntries = Object.entries(layout.ptyIdsByLeafId ?? {})
    const ptyIds = layoutPtyEntries.map(([, ptyId]) => ptyId)
    let retainedSurfaceByPrunedLeafId: Map<string, TerminalSurface> | undefined
    if (layoutPtyEntries.length < Object.keys(ptyIdsByLeafId).length) {
      const retainedLeafIdByPtyId = new Map(
        layoutPtyEntries.map(([leafId, ptyId]) => [ptyId, leafId])
      )
      const surfaceByLeafId = new Map(surfaces.map((surface) => [surface.leafId, surface]))
      retainedSurfaceByPrunedLeafId = new Map()
      for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
        const retainedLeafId = retainedLeafIdByPtyId.get(ptyId)
        if (retainedLeafId && retainedLeafId !== leafId) {
          const retainedSurface = surfaceByLeafId.get(retainedLeafId)
          if (retainedSurface) {
            retainedSurfaceByPrunedLeafId.set(leafId, retainedSurface)
          }
        }
      }
    }
    const launchAgent =
      activeSurface.launchAgent ?? surfaces.find((surface) => surface.launchAgent)?.launchAgent
    const ownerAgent = resolvePaneAgentOwner({
      launchAgent,
      hookAgent: activeSurface.agentStatus?.agentType,
      siblingHookAgent: surfaces.find((surface) => surface.agentStatus?.agentType)?.agentStatus
        ?.agentType
    })
    const title = normalizeCompatibleAgentTitleForOwner(
      activeSurface.title.trim() || surfaces[0]?.title.trim() || 'Terminal',
      ownerAgent
    )
    const existing =
      existingById.get(localTabId) ??
      existingById.get(parentTabId) ??
      surfaces
        .map((surface) => existingById.get(toWebTerminalSurfaceTabId(surface.id)))
        .find((tab): tab is TerminalTab => Boolean(tab))
    const quickCommandLabel =
      activeSurface.quickCommandLabel?.trim() ||
      surfaces.find((surface) => surface.quickCommandLabel?.trim())?.quickCommandLabel?.trim() ||
      existing?.quickCommandLabel?.trim()
    // Why: startupCwd is host-owned launch metadata; once the host omits it, don't resurrect stale subdirectory intent.
    const startupCwd =
      activeSurface.startupCwd || surfaces.find((surface) => surface.startupCwd)?.startupCwd
    // Why: color/pin echo back through host snapshots, so prefer the client's own record and fall back to host only without a prior tab (avoids echo-window reverts).
    const hostColorSurface = surfaces.find((surface) => surface.color != null)
    const color = existing ? (existing.color ?? null) : (hostColorSurface?.color ?? null)
    const isPinned = existing
      ? existing.isPinned === true
      : surfaces.some((surface) => surface.isPinned)
    // Why: viewMode echoes back through host snapshots, so prefer the client's record during the echo window and adopt the host value only without a prior tab.
    const hostViewModeSurface = surfaces.find((surface) => surface.viewMode)
    const viewMode = existing ? existing.viewMode : hostViewModeSurface?.viewMode
    return {
      tab: {
        id: localTabId,
        ptyId: ptyIdsByLeafId[activeSurface.leafId] ?? null,
        worktreeId: snapshot.worktree,
        title,
        defaultTitle: existing?.defaultTitle ?? title,
        // Why: the host transport carries no generated title, so rebuilding the tab
        // without this dropped the client's agent-prompt label on every snapshot.
        ...(existing?.generatedTitle ? { generatedTitle: existing.generatedTitle } : {}),
        ...(existing?.aiVaultTitle ? { aiVaultTitle: existing.aiVaultTitle } : {}),
        ...(quickCommandLabel ? { quickCommandLabel } : {}),
        ...(startupCwd ? { startupCwd } : {}),
        customTitle: existing?.customTitle ?? null,
        color,
        isPinned,
        ...(viewMode ? { viewMode } : {}),
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + index,
        // Why: launchAgent is host-owned lifecycle metadata; once the host omits it, don't resurrect stale startup intent.
        ...(launchAgent ? { launchAgent } : {})
      },
      hostTabId: parentTabId,
      ptyIds,
      layout,
      ...(retainedSurfaceByPrunedLeafId ? { retainedSurfaceByPrunedLeafId } : {})
    }
  })
}

function toMirroredPaneKey(surface: TerminalSurface, leafId = surface.leafId): string | null {
  if (!isTerminalLeafId(leafId)) {
    return null
  }
  return makePaneKey(toWebTerminalSurfaceTabId(surface.parentTabId), leafId)
}

/** Normalises and mirrors agent status updates from the host payload, preserving ownership metadata. */
function remapHostAgentStatus(
  surface: TerminalSurface,
  retainedSurface?: TerminalSurface
): AgentStatusEntry | null {
  if (!surface.agentStatus) {
    return null
  }
  const paneKey = toMirroredPaneKey(surface, retainedSurface?.leafId)
  if (!paneKey) {
    return null
  }
  const ownerAgent = resolvePaneAgentOwner({
    launchAgent: retainedSurface?.launchAgent ?? surface.launchAgent,
    hookAgent: surface.agentStatus.agentType
  })
  return {
    ...normalizeCompatibleAgentStatusEntryForOwner(surface.agentStatus, ownerAgent),
    paneKey,
    tabId: toWebTerminalSurfaceTabId(surface.parentTabId)
  }
}

function isMirroredAgentPaneKeyForTabs(paneKey: string, tabIds: ReadonlySet<string>): boolean {
  const parsed = parsePaneKey(paneKey)
  return parsed !== null && tabIds.has(parsed.tabId)
}

/** Host states the client's byte pipeline cannot observe: permission blocks and
 *  interactive question cards reach the host over its HTTP agent hook, never
 *  through PTY bytes, so they must pierce the client-authority fence. */
function hostAgentStatusPiercesClientAuthority(entry: AgentStatusEntry): boolean {
  return entry.state === 'blocked' || entry.interactivePrompt != null
}

/** True while this renderer's own byte-derived status owns the pane: it claimed
 *  the pane at transport creation and wrote status from bytes. The claim is
 *  released on pane teardown, which is how the host takes the pane back. */
function isClientOwnedAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined
): existing is AgentStatusEntry {
  return existing !== undefined && isClientAuthoritativeAgentStatusPane(paneKey)
}

/** Owned AND still fresh — the arbitration rule for a pane the host also has an
 *  opinion about: an OSC-silent dead agent hands that contest back to the host. */
function isFencedClientAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined,
  now: number
): existing is AgentStatusEntry {
  return isClientOwnedAgentStatus(paneKey, existing) && isAgentStatusFresh(existing, now)
}

function batchAgentPaneKeysForTabs(
  state: WebSessionTabsSyncState,
  tabIds: ReadonlySet<string>,
  batchContext?: WebSessionTabsBatchContext
): string[] {
  if (!batchContext) {
    return Object.keys(state.agentStatusByPaneKey)
  }
  if (!batchContext.agentPaneKeysByTabId) {
    batchContext.agentPaneKeysByTabId = new Map()
    for (const paneKey of Object.keys(state.agentStatusByPaneKey)) {
      const tabId = parsePaneKey(paneKey)?.tabId
      if (!tabId) {
        continue
      }
      const paneKeys = batchContext.agentPaneKeysByTabId.get(tabId) ?? new Set<string>()
      paneKeys.add(paneKey)
      batchContext.agentPaneKeysByTabId.set(tabId, paneKeys)
    }
  }
  return [...tabIds].flatMap((tabId) => [...(batchContext.agentPaneKeysByTabId?.get(tabId) ?? [])])
}

function updateBatchAgentPaneKey(
  paneKey: string,
  present: boolean,
  batchContext?: WebSessionTabsBatchContext
): void {
  const tabId = parsePaneKey(paneKey)?.tabId
  const index = batchContext?.agentPaneKeysByTabId
  if (!tabId || !index) {
    return
  }
  if (present) {
    const paneKeys = index.get(tabId) ?? new Set<string>()
    paneKeys.add(paneKey)
    index.set(tabId, paneKeys)
    return
  }
  const paneKeys = index.get(tabId)
  paneKeys?.delete(paneKey)
  if (paneKeys?.size === 0) {
    index.delete(tabId)
  }
}

// Why: the closed-tab marker has no TTL, and setAgentStatus hard-drops writes for a
// marked tab id — for a stable mirrored id that returns, that is a permanent silent
// blackhole unless presence in a snapshot lifts it.
function buildRemirroredClosedTabMarkerLiftPatch(
  recentlyClosedAgentStatusTabIds: WebSessionTabsSyncState['recentlyClosedAgentStatusTabIds'],
  mirroredTerminalIds: ReadonlySet<string>
): Partial<WebSessionTabsSyncState> | null {
  let next: WebSessionTabsSyncState['recentlyClosedAgentStatusTabIds'] | null = null
  for (const tabId of mirroredTerminalIds) {
    if (tabId in (recentlyClosedAgentStatusTabIds ?? {})) {
      next ??= { ...recentlyClosedAgentStatusTabIds }
      delete next[tabId]
    }
  }
  return next ? { recentlyClosedAgentStatusTabIds: next } : null
}

/**
 * A host retraction owes the retracted tab closeTab's renderer-state sweep: without it,
 * client-owned rows (STA-3107-exempt in the mirror's delete loop) and retention promotions
 * outlive the tab forever (STA-4593).
 */
function buildRetractedMirroredTabSweepPatch(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  nextTabsByWorktree: WebSessionTabsSyncState['tabsByWorktree'],
  agentStatusPatch: Pick<
    WebSessionTabsSyncState,
    'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'
  > | null,
  removedTerminalResourceIds: readonly string[],
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> | null {
  // Why: only a mirrored id the host stopped publishing is a retraction — a local or provisional
  // tab in this list is being renamed into its mirror, and a rename must keep its rows.
  const retractedTabIds = removedTerminalResourceIds.filter(isMirroredTerminalSurfaceId)
  if (retractedTabIds.length === 0) {
    return null
  }
  const sweepState: RetiredTerminalTabSweepState = {
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey ?? {},
    agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey ?? {},
    agentStatusByPaneKey: agentStatusPatch?.agentStatusByPaneKey ?? state.agentStatusByPaneKey,
    agentStatusEpoch: agentStatusPatch?.agentStatusEpoch ?? state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId ?? {},
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey ?? {},
    recentlyClosedAgentStatusTabIds: state.recentlyClosedAgentStatusTabIds ?? {},
    recentlyRetiredAgentStatusPaneKeys: state.recentlyRetiredAgentStatusPaneKeys ?? {},
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey ?? {},
    retentionSuppressedPaneKeys: state.retentionSuppressedPaneKeys ?? {},
    sortEpoch: agentStatusPatch?.sortEpoch ?? state.sortEpoch,
    // Why: the drop's completed-orphan rule reads "keyed under a tab this worktree no longer has",
    // so it must see the post-removal tab list, not the one the snapshot replaced.
    tabsByWorktree: nextTabsByWorktree
  }
  const sweep = buildRetiredTerminalTabStateSweepPatch(sweepState, retractedTabIds, worktreeId)
  if (!sweep?.agentStatusByPaneKey || !batchContext) {
    return sweep ?? null
  }
  // Why: the batch republishes its own record copy at the end, which would undo the sweep.
  const mutableState = state as unknown as Record<string, unknown>
  mutableState.agentStatusByPaneKey = sweep.agentStatusByPaneKey
  batchContext.changedRecords.add('agentStatusByPaneKey')
  for (const paneKey of Object.keys(sweepState.agentStatusByPaneKey)) {
    if (!(paneKey in sweep.agentStatusByPaneKey)) {
      updateBatchAgentPaneKey(paneKey, false, batchContext)
    }
  }
  return sweep
}

function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly TerminalSurface[],
  mirroredTerminalTabs: readonly MirroredTerminalTab[],
  now: number,
  batchContext?: WebSessionTabsBatchContext
): Pick<WebSessionTabsSyncState, 'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'> | null {
  const mirroredTabIds = new Set<string>()
  for (const tab of currentTerminalTabs) {
    if (isWebTerminalSurfaceTabId(tab.id)) {
      mirroredTabIds.add(tab.id)
    }
  }
  for (const surface of terminalSurfaceTabs) {
    mirroredTabIds.add(toWebTerminalSurfaceTabId(surface.parentTabId))
  }

  if (mirroredTabIds.size === 0) {
    return null
  }

  let retainedSurfaceByHostTabAndPrunedLeafId:
    | Map<string, ReadonlyMap<string, TerminalSurface>>
    | undefined
  for (const entry of mirroredTerminalTabs) {
    if (entry.retainedSurfaceByPrunedLeafId) {
      retainedSurfaceByHostTabAndPrunedLeafId ??= new Map()
      retainedSurfaceByHostTabAndPrunedLeafId.set(
        entry.hostTabId,
        entry.retainedSurfaceByPrunedLeafId
      )
    }
  }
  const nextByPaneKey = new Map<string, AgentStatusEntry>()
  for (const surface of terminalSurfaceTabs) {
    const retainedSurface = retainedSurfaceByHostTabAndPrunedLeafId
      ?.get(surface.parentTabId)
      ?.get(surface.leafId)
    const entry = remapHostAgentStatus(surface, retainedSurface)
    if (!entry) {
      continue
    }
    const existing = nextByPaneKey.get(entry.paneKey) ?? state.agentStatusByPaneKey[entry.paneKey]
    // Why: keep fresher OSC state while taking remapped ownership metadata from the authoritative host snapshot.
    const hostIdentityPredatesCurrentTurn =
      existing !== undefined &&
      entry.state === 'done' &&
      existing.state !== 'done' &&
      existing.stateStartedAt > entry.stateStartedAt
    // Why: cross-machine wall clocks are not comparable, so the host frame could
    // outrank live client status forever; a proven client writer keeps its own
    // state (still adopting the host's identity fields below) unless the host
    // carries a state class the client's bytes can never see.
    const clientOwnsEntry =
      isFencedClientAgentStatus(entry.paneKey, existing, now) &&
      !hostAgentStatusPiercesClientAuthority(entry)
    const nextEntry =
      existing && (clientOwnsEntry || existing.updatedAt > entry.updatedAt)
        ? {
            ...normalizeCompatibleAgentStatusEntryForOwner(existing, entry.agentType),
            ...(clientOwnsEntry && existing.state === 'working' && entry.state === 'working'
              ? { workingMode: entry.workingMode }
              : {}),
            paneKey: entry.paneKey,
            worktreeId: entry.worktreeId ?? existing.worktreeId,
            tabId: entry.tabId,
            providerSession:
              existing.providerSession ??
              (hostIdentityPredatesCurrentTurn ? undefined : entry.providerSession),
            // Why: hook-only content the byte pipeline can never see, and every OSC
            // write blanks it, so a fenced pane's message line stayed empty forever
            // (#12906). Host-first unlike providerSession: only the host can mint one.
            lastAssistantMessage:
              (hostIdentityPredatesCurrentTurn ? undefined : entry.lastAssistantMessage) ??
              existing.lastAssistantMessage
          }
        : entry
    nextByPaneKey.set(entry.paneKey, nextEntry)
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let aggregateRelevantChange = false
  let sortRelevantChange = false

  for (const paneKey of batchAgentPaneKeysForTabs(state, mirroredTabIds, batchContext)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    // Why: the host surface carrying no status is not proof the agent stopped —
    // hook-only hosts publish nothing for OSC-driven panes. Keep a live entry
    // this renderer owns; it decays through the normal freshness boundary.
    // Ownership, not freshness, is the gate here: with no competing host value
    // there is nothing to arbitrate, and a client asleep past the stale
    // boundary would otherwise erase every pane it owns on the first snapshot
    // after wake (STA-3107) instead of decaying it like a local pane.
    if (isClientOwnedAgentStatus(paneKey, state.agentStatusByPaneKey[paneKey])) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    delete nextAgentStatusByPaneKey[paneKey]
    updateBatchAgentPaneKey(paneKey, false, batchContext)
    changed = true
    aggregateRelevantChange = true
    sortRelevantChange = true
  }

  for (const [paneKey, entry] of nextByPaneKey) {
    const existing = nextAgentStatusByPaneKey[paneKey]
    if (agentStatusEntryEqual(existing, entry)) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    nextAgentStatusByPaneKey[paneKey] = entry
    updateBatchAgentPaneKey(paneKey, true, batchContext)
    changed = true
    const entryAttributionChanged =
      existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
    const entryFreshnessChanged =
      !!existing && isAgentStatusFresh(existing, now) !== isAgentStatusFresh(entry, now)
    const doneAttentionChanged =
      existing?.state === 'done' &&
      entry.state === 'done' &&
      agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
    const workingModeChanged = existing?.workingMode !== entry.workingMode
    const entrySortRelevantChange =
      !existing ||
      existing.state !== entry.state ||
      !isAgentStatusFresh(existing, now) ||
      entryFreshnessChanged ||
      entryAttributionChanged ||
      doneAttentionChanged ||
      isMirroredCommandCodeTurnBump(existing, entry)
    aggregateRelevantChange =
      aggregateRelevantChange || entrySortRelevantChange || workingModeChanged
    sortRelevantChange = sortRelevantChange || entrySortRelevantChange
  }

  if (!changed) {
    return null
  }

  return {
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    agentStatusEpoch: aggregateRelevantChange ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: sortRelevantChange ? state.sortEpoch + 1 : state.sortEpoch
  }
}

function buildTerminalUnifiedTab(
  tab: TerminalTab,
  groupId: string,
  environmentId: string,
  // Why: viewMode is host-tracked but the client's optimistic toggle must win during the echo window; callers pass the reconciled value.
  viewMode?: Tab['viewMode']
): Tab {
  return {
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    contentType: 'terminal',
    label: tab.title,
    ...(tab.quickCommandLabel?.trim() ? { quickCommandLabel: tab.quickCommandLabel.trim() } : {}),
    ...(tab.generatedTitle?.trim() ? { generatedLabel: tab.generatedTitle.trim() } : {}),
    ...(tab.aiVaultTitle ? { aiVaultTitle: tab.aiVaultTitle } : {}),
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned: tab.isPinned === true,
    ...(viewMode ? { viewMode } : {})
  }
}

function buildBrowserUnifiedTab(
  tab: BrowserWorkspace,
  hostTab: RuntimeMobileSessionBrowserTab,
  existingUnifiedTab: Tab | null,
  groupId: string,
  environmentId: string
): Tab {
  return {
    id: existingUnifiedTab?.id ?? hostTab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    contentType: 'browser',
    label: tab.title,
    customLabel: null,
    color: hostTab.color !== undefined ? hostTab.color : (existingUnifiedTab?.color ?? null),
    sortOrder: tab.createdAt,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned:
      hostTab.isPinned !== undefined
        ? hostTab.isPinned === true
        : existingUnifiedTab?.isPinned === true
  }
}

function buildEditorUnifiedTab(
  file: OpenFile,
  tab: ReadyEditorSurface,
  hostTabId: string,
  existingUnifiedTab: Tab | null,
  label: string,
  groupId: string,
  sortOrder: number,
  createdAt: number,
  environmentId: string
): Tab {
  return {
    id: hostTabId,
    entityId: file.id,
    groupId,
    worktreeId: file.worktreeId,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    contentType: 'editor',
    label,
    customLabel: null,
    color: tab.color !== undefined ? tab.color : (existingUnifiedTab?.color ?? null),
    sortOrder,
    createdAt,
    isPreview: false,
    isPinned:
      tab.isPinned !== undefined ? tab.isPinned === true : existingUnifiedTab?.isPinned === true
  }
}

function buildMirroredEditorTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  worktreeOpenFileById: ReadonlyMap<string, OpenFile>,
  existingTabIndex: WebSessionExistingTabIndex,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number
): MirroredEditorTab[] {
  return snapshot.tabs.filter(isReadyEditorTab).map((tab, index) => {
    const fileId = localEditorFileId(tab)
    const existingFile = worktreeOpenFileById.get(fileId)
    const existingUnifiedTab = existingTabIndex.getEditorUnifiedTab(fileId, tab.id)
    const sourceFileId = editorSourceFileId(tab)
    const groupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    const file: OpenFile = {
      ...existingFile,
      id: fileId,
      filePath: tab.filePath,
      relativePath: tab.relativePath,
      worktreeId: snapshot.worktree,
      language: tab.language,
      isDirty: tab.isDirty,
      runtimeEnvironmentId: environmentId,
      mode: tab.type === 'markdown' ? tab.mode : 'edit',
      markdownPreviewSourceFileId: sourceFileId,
      // Why: marks this tab host-owned so a later snapshot that omits it can cull it; locally opened tabs lack this flag and survive.
      mirroredFromRuntimeSession: true
    }
    return {
      file,
      hostTabId: tab.id,
      unifiedTab: buildEditorUnifiedTab(
        file,
        tab,
        tab.id,
        existingUnifiedTab,
        tab.title.trim() || tab.relativePath || 'File',
        groupId,
        sortOffset + index,
        existingUnifiedTab?.createdAt ?? now + sortOffset + index,
        environmentId
      )
    }
  })
}

function findBrowserWorkspaceForRemotePage(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  environmentId: string,
  remotePageId: string
): { workspace: BrowserWorkspace; page: BrowserPage; unifiedTab: Tab | null } | null {
  const workspaces = state.browserTabsByWorktree[worktreeId] ?? []
  for (const workspace of workspaces) {
    const pages = state.browserPagesByWorkspace[workspace.id] ?? []
    for (const page of pages) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle?.environmentId === environmentId && handle.remotePageId === remotePageId) {
        return {
          workspace,
          page,
          unifiedTab:
            (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
            ) ?? null
        }
      }
    }
  }
  return null
}

function browserWorkspaceHasRemoteEnvironmentPage(
  state: WebSessionTabsSyncState,
  workspace: BrowserWorkspace,
  environmentId: string
): boolean {
  return (state.browserPagesByWorkspace[workspace.id] ?? []).some(
    (page) => state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId === environmentId
  )
}

function buildMirroredBrowserTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  state: WebSessionTabsSyncState,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number
): MirroredBrowserTab[] {
  const renderedGroupIds = collectLayoutGroupIds(state.layoutByWorktree[snapshot.worktree])
  const clientGroupIds = new Set(
    (state.groupsByWorktree[snapshot.worktree] ?? []).map((group) => group.id)
  )
  return snapshot.tabs.filter(isReadyBrowserTab).map((tab, index) => {
    const existing = findBrowserWorkspaceForRemotePage(
      state,
      snapshot.worktree,
      environmentId,
      tab.browserPageId
    )
    const workspaceId = existing?.workspace.id ?? tab.browserWorkspaceId
    const pageId = existing?.page.id ?? tab.browserPageId
    const createdAt = existing?.page.createdAt ?? now + sortOffset + index
    const recordedClientGroupId = peekWebSessionBrowserPlacementGroup({
      environmentId,
      worktreeId: snapshot.worktree,
      remotePageId: tab.browserPageId
    })
    const hostGroupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    const existingClientGroupId =
      existing?.unifiedTab?.groupId !== hostGroupId ? existing?.unifiedTab?.groupId : undefined
    const preferredClientGroupId = recordedClientGroupId ?? existingClientGroupId
    const clientGroupId =
      preferredClientGroupId &&
      clientGroupIds.has(preferredClientGroupId) &&
      (renderedGroupIds.size === 0 || renderedGroupIds.has(preferredClientGroupId))
        ? preferredClientGroupId
        : undefined
    const groupId = clientGroupId ?? hostGroupId
    const title = tab.title.trim() || 'Browser'
    const nextPage: BrowserPage = {
      id: pageId,
      workspaceId,
      worktreeId: snapshot.worktree,
      url: tab.url,
      title,
      loading: tab.loading,
      faviconUrl: existing?.page.faviconUrl ?? null,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      loadError: tab.loadError ?? null,
      createdAt,
      browserRuntimeEnvironmentId: environmentId,
      viewportPresetId: existing?.page.viewportPresetId ?? null
    }
    // Why: reuse hinges on browserPageEqual comparing workspaceId — the removed-workspace
    // page-list cleanup gates on page.workspaceId matching this entry's workspace.id.
    const page = existing && browserPageEqual(existing.page, nextPage) ? existing.page : nextPage
    const workspace: BrowserWorkspace = {
      id: workspaceId,
      worktreeId: snapshot.worktree,
      label: existing?.workspace.label,
      sessionProfileId: existing?.workspace.sessionProfileId ?? null,
      activePageId: page.id,
      pageIds: [page.id],
      url: page.url,
      title: page.title,
      loading: page.loading,
      faviconUrl: page.faviconUrl,
      canGoBack: page.canGoBack,
      canGoForward: page.canGoForward,
      loadError: page.loadError,
      createdAt
    }
    return {
      workspace,
      page,
      certificateFailure: tab.certificateFailure ?? null,
      remotePageId: tab.browserPageId,
      unifiedTab: buildBrowserUnifiedTab(
        workspace,
        tab,
        existing?.unifiedTab ?? null,
        groupId,
        environmentId
      ),
      hostTabId: tab.id,
      ...(clientGroupId ? { clientGroupId } : {})
    }
  })
}

function chooseTargetGroupId(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): string {
  const groups = state.groupsByWorktree[snapshot.worktree] ?? []
  const layoutGroupIds = collectLayoutGroupIds(state.layoutByWorktree[snapshot.worktree])
  const inRenderedLayout = (groupId: string | null | undefined): boolean =>
    Boolean(groupId && (layoutGroupIds.size === 0 || layoutGroupIds.has(groupId)))
  const preferred =
    groups.find((group) => group.id === snapshot.activeGroupId && inRenderedLayout(group.id)) ??
    groups.find(
      (group) =>
        group.id === state.activeGroupIdByWorktree[snapshot.worktree] && inRenderedLayout(group.id)
    ) ??
    groups.find((group) => inRenderedLayout(group.id))
  // Why: host snapshots can reference desktop-only group ids; the rendered group is the only safe CSS anchor for mirrored panes.
  const firstRenderedLayoutGroupId = layoutGroupIds.values().next().value as string | undefined
  return (
    preferred?.id ??
    firstRenderedLayoutGroupId ??
    snapshot.activeGroupId ??
    `${WEB_SESSION_GROUP_PREFIX}${snapshot.worktree}`
  )
}

function collectLayoutGroupIds(layout: TabGroupLayoutNode | undefined): Set<string> {
  const result = new Set<string>()
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.add(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

function buildHostGroupIdByTabId(
  hostGroups: readonly RuntimeMobileSessionTabGroup[] | undefined
): Map<string, string> {
  const result = new Map<string, string>()
  for (const group of hostGroups ?? []) {
    for (const tabId of group.tabOrder) {
      result.set(tabId, group.id)
    }
    if (group.activeTabId) {
      result.set(group.activeTabId, group.id)
    }
  }
  return result
}

function pruneTabGroupLayout(
  layout: TabGroupLayoutNode | null | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneTabGroupLayout(layout.first, validGroupIds)
  const second = pruneTabGroupLayout(layout.second, validGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

function dropTabGroupLayoutGroups(
  layout: TabGroupLayoutNode | null,
  excludedGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return excludedGroupIds.has(layout.groupId) ? null : layout
  }
  const first = dropTabGroupLayoutGroups(layout.first, excludedGroupIds)
  const second = dropTabGroupLayoutGroups(layout.second, excludedGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

function appendTabGroupLayout(
  first: TabGroupLayoutNode | null,
  second: TabGroupLayoutNode | null
): TabGroupLayoutNode | null {
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  // Why: a group already placed by `first` must not gain a second leaf — two
  // leaves for one group render the same tab strip in two columns, and each
  // later snapshot appends another copy.
  const appended = dropTabGroupLayoutGroups(second, collectLayoutGroupIds(first))
  if (!appended) {
    return first
  }
  return {
    type: 'split',
    direction: 'horizontal',
    first,
    second: appended
  }
}

function tabGroupLayoutEqual(
  a: TabGroupLayoutNode | null | undefined,
  b: TabGroupLayoutNode | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  if (a.type !== b.type) {
    return false
  }
  if (a.type === 'leaf') {
    return b.type === 'leaf' && a.groupId === b.groupId
  }
  return (
    b.type === 'split' &&
    a.direction === b.direction &&
    a.ratio === b.ratio &&
    tabGroupLayoutEqual(a.first, b.first) &&
    tabGroupLayoutEqual(a.second, b.second)
  )
}

function mapHostRecentTabIds(
  recentTabIds: readonly string[] | undefined,
  hostToLocalTabId: ReadonlyMap<string, string>,
  tabOrder: readonly string[]
): string[] {
  if (!recentTabIds || recentTabIds.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  return sanitizeRecentTabIds(
    recentTabIds.map((tabId) => hostToLocalTabId.get(tabId) ?? '').filter(Boolean),
    [...valid]
  )
}

function buildHostToLocalTabIdMap({
  terminalSurfaces,
  terminalTabs,
  browserTabs,
  editorTabs
}: {
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
}): Map<string, string> {
  const hostToLocal = new Map<string, string>()
  const terminalIds = new Set(terminalTabs.map((tab) => tab.id))
  for (const surface of terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (terminalIds.has(localId)) {
      hostToLocal.set(surface.parentTabId, localId)
      hostToLocal.set(surface.id, localId)
    }
  }
  for (const entry of browserTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
    hostToLocal.set(entry.unifiedTab.id, entry.unifiedTab.id)
  }
  for (const entry of editorTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  return hostToLocal
}

function updateHostSessionTabIdMappings(args: {
  environmentId: string
  worktreeId: string
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
}): void {
  clearHostSessionTabIdMappings(args.environmentId, args.worktreeId)

  const mirroredTerminalIds = new Set(args.terminalTabs.map((tab) => tab.id))
  for (const surface of args.terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (mirroredTerminalIds.has(localId)) {
      setHostSessionTabIdMapping({ ...args, tabId: localId }, surface.parentTabId)
    }
  }
  for (const entry of args.browserTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.editorTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
}

function retainClientPlacedMirroredTabs(args: {
  groups: readonly TabGroup[]
  mirroredUnifiedIds: ReadonlySet<string>
  validUnifiedTabIds: ReadonlySet<string>
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
  nextActiveUnifiedTabId: string | null
}): TabGroup[] {
  return args.groups.map((group) => {
    const retainedTabOrder = group.tabOrder.filter(
      (tabId) =>
        args.validUnifiedTabIds.has(tabId) &&
        (!args.mirroredUnifiedIds.has(tabId) ||
          args.clientGroupIdByLocalTabId.get(tabId) === group.id)
    )
    const placedTabIds = [...args.clientGroupIdByLocalTabId]
      .filter(
        ([tabId, groupId]) =>
          groupId === group.id &&
          args.validUnifiedTabIds.has(tabId) &&
          !retainedTabOrder.includes(tabId)
      )
      .map(([tabId]) => tabId)
    const tabOrder = [...retainedTabOrder, ...placedTabIds]
    const activeTabId =
      args.nextActiveUnifiedTabId && tabOrder.includes(args.nextActiveUnifiedTabId)
        ? args.nextActiveUnifiedTabId
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
    return {
      ...group,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, tabOrder), activeTabId)
        : []
    }
  })
}

function buildMirroredHostGroups({
  currentGroups,
  hostGroups,
  hostToLocalTabId,
  mirroredUnifiedIds,
  nextActiveUnifiedTabId,
  now,
  validUnifiedTabIds,
  environmentId,
  worktreeId,
  clientGroupIdByLocalTabId
}: {
  currentGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
  hostToLocalTabId: ReadonlyMap<string, string>
  mirroredUnifiedIds: ReadonlySet<string>
  nextActiveUnifiedTabId: string | null
  now: number
  validUnifiedTabIds: ReadonlySet<string>
  environmentId: string
  worktreeId: string
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
}): TabGroup[] | null {
  const strippedGroups = retainClientPlacedMirroredTabs({
    groups: currentGroups,
    mirroredUnifiedIds,
    validUnifiedTabIds,
    clientGroupIdByLocalTabId,
    nextActiveUnifiedTabId
  })
  const groupsById = new Map(strippedGroups.map((group) => [group.id, group]))
  const orderedGroups: TabGroup[] = []
  const seen = new Set<string>()

  for (const hostGroup of hostGroups) {
    const existing = groupsById.get(hostGroup.id)
    const localHostOrder = hostGroup.tabOrder
      .map((tabId) => hostToLocalTabId.get(tabId))
      .filter(
        (tabId): tabId is string =>
          tabId !== undefined &&
          validUnifiedTabIds.has(tabId) &&
          !clientGroupIdByLocalTabId.has(tabId)
      )
    const localHostOrderIds = new Set(localHostOrder)
    const hostTabOrder = [
      ...(existing?.tabOrder.filter((tabId) => !localHostOrderIds.has(tabId)) ?? []),
      ...localHostOrder
    ]
    // Why: a pending client reorder wins over a stale pre-move host order until the host echoes the move (or membership changes).
    const tabOrder = resolveWebSessionReorderedOrder(
      { environmentId },
      worktreeId,
      hostGroup.id,
      hostTabOrder,
      now
    )
    if (tabOrder.length === 0) {
      continue
    }
    const activeFromHost =
      hostGroup.activeTabId !== null ? (hostToLocalTabId.get(hostGroup.activeTabId) ?? null) : null
    const activeTabId =
      nextActiveUnifiedTabId && tabOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : activeFromHost && tabOrder.includes(activeFromHost)
          ? activeFromHost
          : existing?.activeTabId && tabOrder.includes(existing.activeTabId)
            ? existing.activeTabId
            : (tabOrder[0] ?? null)
    orderedGroups.push({
      id: hostGroup.id,
      worktreeId,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(
            mapHostRecentTabIds(hostGroup.recentTabIds, hostToLocalTabId, tabOrder),
            activeTabId
          )
        : []
    })
    seen.add(hostGroup.id)
  }

  for (const group of strippedGroups) {
    if (
      !seen.has(group.id) &&
      (group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId: group.id }))
    ) {
      orderedGroups.push(group)
    }
  }

  return orderedGroups.length > 0 ? orderedGroups : null
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

function sameAgentStateHistory(
  a: AgentStatusEntry['stateHistory'],
  b: AgentStatusEntry['stateHistory']
): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every(
    (entry, index) =>
      entry.state === b[index]?.state &&
      entry.prompt === b[index]?.prompt &&
      entry.startedAt === b[index]?.startedAt &&
      entry.interrupted === b[index]?.interrupted
  )
}

function agentStatusEntryEqual(a: AgentStatusEntry | undefined, b: AgentStatusEntry): boolean {
  if (!a) {
    return false
  }
  return (
    a.state === b.state &&
    a.workingMode === b.workingMode &&
    a.prompt === b.prompt &&
    a.updatedAt === b.updatedAt &&
    a.stateStartedAt === b.stateStartedAt &&
    a.agentType === b.agentType &&
    a.paneKey === b.paneKey &&
    a.worktreeId === b.worktreeId &&
    a.tabId === b.tabId &&
    a.terminalTitle === b.terminalTitle &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.interactivePrompt === b.interactivePrompt &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.interrupted === b.interrupted &&
    a.promptInteractionKey === b.promptInteractionKey &&
    a.restoredUnconfirmed === b.restoredUnconfirmed &&
    agentProviderSessionsEqual(a.agentType, a.providerSession, b.providerSession) &&
    sameAgentStateHistory(a.stateHistory, b.stateHistory)
  )
}

function isAgentStatusFresh(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'restoredUnconfirmed'>,
  now: number
): boolean {
  return entry.restoredUnconfirmed !== true && now - entry.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
}

function isMirroredCommandCodeTurnBump(
  existing: AgentStatusEntry | undefined,
  entry: AgentStatusEntry
): boolean {
  return (
    existing?.agentType === 'command-code' &&
    entry.agentType === 'command-code' &&
    existing.state === 'working' &&
    entry.state === 'working' &&
    entry.stateStartedAt > existing.stateStartedAt
  )
}

function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.toReversed()
}

function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  return [...base.filter((id) => id !== tabId), tabId]
}

function writableWebSessionTabsRecord<K extends WebSessionTabsBatchRecordKey>(
  state: WebSessionTabsSyncState,
  recordKey: K,
  batchContext?: WebSessionTabsBatchContext
): NonNullable<WebSessionTabsSyncState[K]> {
  const record = (state[recordKey] ?? {}) as NonNullable<WebSessionTabsSyncState[K]>
  if (!batchContext) {
    return { ...record } as NonNullable<WebSessionTabsSyncState[K]>
  }
  // Why: one batch owns its record copies, so later snapshots can update them without recopying every workspace.
  if (batchContext.changedRecords.has(recordKey)) {
    return record
  }
  const next = { ...record } as NonNullable<WebSessionTabsSyncState[K]>
  const mutableState = state as unknown as Record<
    WebSessionTabsBatchRecordKey,
    Record<string, unknown>
  >
  mutableState[recordKey] = next as Record<string, unknown>
  batchContext.changedRecords.add(recordKey)
  return next
}

function withWorktreeEntry<T>(
  state: WebSessionTabsSyncState,
  recordKey: WebSessionTabsBatchRecordKey,
  key: string,
  value: T | null,
  equal: (a: T | undefined, b: T | null) => boolean,
  batchContext?: WebSessionTabsBatchContext,
  deleteNull = true
): Record<string, T> {
  const record = (state[recordKey] ?? {}) as Record<string, T>
  if (equal(record[key], value)) {
    return record
  }
  const next = writableWebSessionTabsRecord(state, recordKey, batchContext) as Record<string, T>
  if (value === null && deleteNull) {
    delete next[key]
  } else {
    next[key] = value as T
  }
  return next
}

function terminalTabEqual(a: TerminalTab, b: TerminalTab): boolean {
  return (
    a.id === b.id &&
    a.ptyId === b.ptyId &&
    a.worktreeId === b.worktreeId &&
    a.title === b.title &&
    a.defaultTitle === b.defaultTitle &&
    a.quickCommandLabel === b.quickCommandLabel &&
    a.startupCwd === b.startupCwd &&
    a.generatedTitle === b.generatedTitle &&
    a.aiVaultTitle?.agent === b.aiVaultTitle?.agent &&
    a.aiVaultTitle?.sessionId === b.aiVaultTitle?.sessionId &&
    a.aiVaultTitle?.title === b.aiVaultTitle?.title &&
    a.customTitle === b.customTitle &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.generation === b.generation &&
    a.shellOverride === b.shellOverride &&
    a.launchAgent === b.launchAgent &&
    a.pendingActivationSpawn === b.pendingActivationSpawn
  )
}

function sameTerminalTabs(
  a: readonly TerminalTab[] | undefined,
  b: readonly TerminalTab[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => terminalTabEqual(tab, right[index]!))
}

function browserPageEqual(a: BrowserPage, b: BrowserPage): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.worktreeId === b.worktreeId &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.faviconUrl === b.faviconUrl &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.loadError?.code === b.loadError?.code &&
    a.loadError?.description === b.loadError?.description &&
    a.loadError?.validatedUrl === b.loadError?.validatedUrl &&
    a.createdAt === b.createdAt &&
    a.browserRuntimeEnvironmentId === b.browserRuntimeEnvironmentId &&
    a.viewportPresetId === b.viewportPresetId
  )
}

function browserCertificateFailureEqual(
  a: BrowserCertificateFailure | null | undefined,
  b: BrowserCertificateFailure | null | undefined
): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === right) {
    return true
  }
  return Boolean(
    left &&
    right &&
    left.challengeId === right.challengeId &&
    left.browserPageId === right.browserPageId &&
    left.errorCode === right.errorCode &&
    left.error === right.error &&
    left.origin === right.origin &&
    left.displayHost === right.displayHost &&
    left.canProceed === right.canProceed &&
    left.observedAt === right.observedAt
  )
}

function sameBrowserPages(
  a: readonly BrowserPage[] | undefined,
  b: readonly BrowserPage[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((page, index) => browserPageEqual(page, right[index]!))
}

function browserWorkspaceEqual(a: BrowserWorkspace, b: BrowserWorkspace): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.label === b.label &&
    a.sessionProfileId === b.sessionProfileId &&
    a.activePageId === b.activePageId &&
    sameStringArray(a.pageIds ?? [], b.pageIds ?? []) &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.faviconUrl === b.faviconUrl &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.loadError?.code === b.loadError?.code &&
    a.loadError?.description === b.loadError?.description &&
    a.loadError?.validatedUrl === b.loadError?.validatedUrl &&
    a.createdAt === b.createdAt
  )
}

function sameBrowserTabs(
  a: readonly BrowserWorkspace[] | undefined,
  b: readonly BrowserWorkspace[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => browserWorkspaceEqual(tab, right[index]!))
}

function openFileEqual(a: OpenFile, b: OpenFile): boolean {
  return (
    a.id === b.id &&
    a.filePath === b.filePath &&
    a.relativePath === b.relativePath &&
    a.worktreeId === b.worktreeId &&
    a.language === b.language &&
    a.isDirty === b.isDirty &&
    a.runtimeEnvironmentId === b.runtimeEnvironmentId &&
    a.markdownPreviewSourceFileId === b.markdownPreviewSourceFileId &&
    a.markdownPreviewAnchor === b.markdownPreviewAnchor &&
    a.isPreview === b.isPreview &&
    a.isUntitled === b.isUntitled &&
    a.deleteUntouchedOnClose === b.deleteUntouchedOnClose &&
    a.externalMutation === b.externalMutation &&
    a.mirroredFromRuntimeSession === b.mirroredFromRuntimeSession &&
    a.mode === b.mode
  )
}

function sameOpenFiles(a: readonly OpenFile[], b: readonly OpenFile[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((file, index) => openFileEqual(file, b[index]!))
}

/** This worktree's open files — the only scope a snapshot reconciles, so a batch can
 *  answer from here instead of walking every open file in the app. */
function webSessionOpenFilesForWorktree(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): readonly OpenFile[] {
  if (!batchContext) {
    return state.openFiles.filter((file) => file.worktreeId === worktreeId)
  }
  let index = batchContext.openFilesIndex
  if (!index || index.source !== state.openFiles) {
    const byWorktree = new Map<string, OpenFile[]>()
    for (const file of state.openFiles) {
      const bucket = byWorktree.get(file.worktreeId) ?? []
      bucket.push(file)
      byWorktree.set(file.worktreeId, bucket)
    }
    index = { source: state.openFiles, byWorktree }
    batchContext.openFilesIndex = index
  }
  return index.byWorktree.get(worktreeId) ?? []
}

/** Retargets the index at the array a snapshot just produced, re-bucketing only the
 *  worktree that changed. Rebuilding it wholesale would cost the entire array again on
 *  every snapshot, which is the cost this index exists to avoid. */
function advanceWebSessionOpenFilesIndex(
  batchContext: WebSessionTabsBatchContext | undefined,
  nextOpenFiles: readonly OpenFile[],
  worktreeId: string
): void {
  const index = batchContext?.openFilesIndex
  if (!index || index.source === nextOpenFiles) {
    return
  }
  const bucket: OpenFile[] = []
  for (const file of nextOpenFiles) {
    if (file.worktreeId === worktreeId) {
      bucket.push(file)
    }
  }
  index.byWorktree.set(worktreeId, bucket)
  index.source = nextOpenFiles
}

/** Mirrors `openFiles.find()` first-wins lookup, which duplicate ids make observable. */
function firstOpenFileByIdForWorktree(files: readonly OpenFile[]): Map<string, OpenFile> {
  const byId = new Map<string, OpenFile>()
  for (const file of files) {
    if (!byId.has(file.id)) {
      byId.set(file.id, file)
    }
  }
  return byId
}

function tabEqual(a: Tab, b: Tab): boolean {
  return (
    a.id === b.id &&
    a.entityId === b.entityId &&
    a.groupId === b.groupId &&
    a.worktreeId === b.worktreeId &&
    a.executionHostId === b.executionHostId &&
    a.contentType === b.contentType &&
    a.label === b.label &&
    // Why: the generated label is the visible tab title; ignoring it let the
    // equality bail keep a unified tab that disagreed with its terminal tab.
    a.generatedLabel === b.generatedLabel &&
    a.aiVaultTitle?.agent === b.aiVaultTitle?.agent &&
    a.aiVaultTitle?.sessionId === b.aiVaultTitle?.sessionId &&
    a.aiVaultTitle?.title === b.aiVaultTitle?.title &&
    a.customLabel === b.customLabel &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.isPreview === b.isPreview &&
    a.isPinned === b.isPinned
  )
}

function sameUnifiedTabs(a: readonly Tab[] | undefined, b: readonly Tab[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => tabEqual(tab, right[index]!))
}

function groupEqual(a: TabGroup, b: TabGroup): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.activeTabId === b.activeTabId &&
    sameStringArray(a.tabOrder, b.tabOrder) &&
    sameStringArray(a.recentTabIds ?? [], b.recentTabIds ?? [])
  )
}

function sameGroups(a: readonly TabGroup[] | undefined, b: readonly TabGroup[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((group, index) => groupEqual(group, right[index]!))
}

function toVisibleTabType(tab: Tab): WebSessionTabsSyncState['activeTabType'] {
  if (tab.contentType === 'browser' || tab.contentType === 'terminal') {
    return tab.contentType
  }
  return 'editor'
}

function applyWebSessionTabsSnapshotWithContext(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  batchContext?: WebSessionTabsBatchContext
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (suppressE2eWebRuntimeBrowserSnapshot(rawSnapshot)) {
    return state
  }
  const worktreeId = rawSnapshot.worktree
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return state
  }
  // Why: an in-flight pre-close snapshot can flash a closing tab back, so drop tabs the client is closing until the host confirms removal.
  // Why: key close intents by host session tab id (terminal parentTabId else tab.id), not browserPageId, or browser closes never get suppressed.
  const snapshotHostTabId = (tab: RuntimeMobileSessionTabsResult['tabs'][number]): string =>
    tab.type === 'terminal' ? tab.parentTabId : tab.id
  reconcileWebSessionCloseIntents(
    { environmentId },
    worktreeId,
    new Set(rawSnapshot.tabs.map((tab) => snapshotHostTabId(tab)))
  )
  const snapshot: RuntimeMobileSessionTabsResult = rawSnapshot.tabs.some((tab) =>
    isWebSessionCloseIntentPending({ environmentId }, worktreeId, snapshotHostTabId(tab), now)
  )
    ? {
        ...rawSnapshot,
        tabs: rawSnapshot.tabs.filter(
          (tab) =>
            !isWebSessionCloseIntentPending(
              { environmentId },
              worktreeId,
              snapshotHostTabId(tab),
              now
            )
        )
      }
    : rawSnapshot
  // Why: only a caller-recorded create intent may focus its arriving tab; unsolicited server-active must not steal focus (#5435).
  const focusIntent = peekWebSessionFocusIntent({ environmentId }, worktreeId)
  const focusIntentHostTabId = focusIntent?.hostTabId ?? null
  const matchingFocusIntentTab =
    focusIntentHostTabId === null
      ? null
      : focusIntent?.leafId
        ? (snapshot.tabs.find(
            (tab) =>
              tab.type === 'terminal' &&
              tab.leafId === focusIntent.leafId &&
              (tab.id === focusIntentHostTabId || tab.parentTabId === focusIntentHostTabId)
          ) ?? null)
        : (snapshot.tabs.find(
            (tab) =>
              tab.id === focusIntentHostTabId ||
              (tab.type === 'terminal' && tab.parentTabId === focusIntentHostTabId) ||
              (tab.type === 'browser' && tab.browserPageId === focusIntentHostTabId)
          ) ?? null)
  const expectedCurrentLocalTabId = focusIntent?.expectedCurrentLocalTabId
  const currentVisibleLocalTabId = resolveWebSessionVisibleTabId(state, worktreeId)
  const callerFocusIntentTab =
    matchingFocusIntentTab &&
    (expectedCurrentLocalTabId === undefined ||
      expectedCurrentLocalTabId === currentVisibleLocalTabId)
      ? matchingFocusIntentTab
      : null
  const followIntentTab =
    snapshot.navigationIntent === 'follow'
      ? (snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null)
      : null
  const navigationIntentTab = callerFocusIntentTab ?? followIntentTab
  const honorSnapshotActiveFocus = navigationIntentTab !== null
  if (matchingFocusIntentTab) {
    clearWebSessionFocusIntent({ environmentId }, worktreeId)
  }
  const currentTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const existingTerminalById = new Map(currentTerminalTabs.map((tab) => [tab.id, tab]))
  const terminalSurfaceTabs = snapshot.tabs.filter(isTerminalSurfaceTab)
  const readyTerminalTabs = terminalSurfaceTabs.filter(isReadyTerminalTab)
  const nextRemotePtyIds = new Set(
    readyTerminalTabs.map((tab) => toRemoteRuntimePtyId(tab.terminal, environmentId))
  )
  const nextMirroredTerminalIds = new Set(
    terminalSurfaceTabs.map((tab) => toWebTerminalSurfaceTabId(tab.parentTabId))
  )
  const nextHostTerminalTabIds = new Set(terminalSurfaceTabs.map((tab) => tab.parentTabId))
  const exactProvisionalHandoffs = new Set(
    currentTerminalTabs
      .filter((tab) => !isMirroredTerminalSurfaceId(tab.id))
      .filter((tab) => {
        if (nextHostTerminalTabIds.has(tab.id)) {
          return true
        }
        const handoff = {
          environmentId,
          worktreeId,
          provisionalTabId: tab.id
        }
        const hostTabId = resolveWebAgentSessionHandoff(handoff)
        return (
          hostTabId !== null &&
          (nextHostTerminalTabIds.has(hostTabId) ||
            isWebAgentSessionHandoffPostCreateSnapshotConfirmed(handoff))
        )
      })
      .map((tab) => tab.id)
  )
  const retainedTerminalTabs = currentTerminalTabs.filter(
    (tab) =>
      !shouldReplaceTerminalTab(
        tab,
        environmentId,
        nextRemotePtyIds,
        nextMirroredTerminalIds,
        exactProvisionalHandoffs
      )
  )
  const mirroredTerminalTabs = buildMirroredTerminalTabs(
    snapshot,
    environmentId,
    existingTerminalById,
    state.terminalLayoutsByTabId,
    retainedTerminalTabs.length,
    now,
    callerFocusIntentTab?.type === 'terminal'
      ? {
          parentTabId: callerFocusIntentTab.parentTabId,
          leafId: callerFocusIntentTab.leafId
        }
      : undefined
  )
  const mirroredTerminalTabEntries = mirroredTerminalTabs.map((entry) => entry.tab)
  const retainedTerminalIds = new Set(retainedTerminalTabs.map((tab) => tab.id))
  const nextTerminalTabs =
    retainedTerminalTabs.length + mirroredTerminalTabEntries.length > 0
      ? [...retainedTerminalTabs, ...mirroredTerminalTabEntries]
      : null
  const mirroredTerminalIds = new Set(mirroredTerminalTabEntries.map((tab) => tab.id))
  const removedTerminalIds = new Set(
    currentTerminalTabs.filter((tab) => !retainedTerminalIds.has(tab.id)).map((tab) => tab.id)
  )
  const removedTerminalResourceIds = [...removedTerminalIds].filter(
    (tabId) => !mirroredTerminalIds.has(tabId)
  )
  for (const provisionalTabId of exactProvisionalHandoffs) {
    clearWebAgentSessionHandoff({ environmentId, worktreeId, provisionalTabId })
  }

  const targetGroupId = chooseTargetGroupId(state, snapshot)
  const hostGroupIdByTabId = buildHostGroupIdByTabId(snapshot.tabGroups)
  const existingTabIndex = buildWebSessionExistingTabIndex({
    unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? []
  })
  const readyBrowserTabs = snapshot.tabs.filter(isReadyBrowserTab)
  const nextRemoteBrowserPageIds = new Set(readyBrowserTabs.map((tab) => tab.browserPageId))
  const mirroredBrowserTabs = buildMirroredBrowserTabs(
    snapshot,
    environmentId,
    state,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length,
    now
  )
  const mirroredBrowserWorkspaceIds = new Set(
    mirroredBrowserTabs.map((entry) => entry.workspace.id)
  )
  const currentBrowserTabs = state.browserTabsByWorktree[worktreeId] ?? []
  const removedBrowserWorkspaceIds = new Set(
    currentBrowserTabs
      .filter((tab) => {
        if (mirroredBrowserWorkspaceIds.has(tab.id)) {
          return true
        }
        if (!browserWorkspaceHasRemoteEnvironmentPage(state, tab, environmentId)) {
          return false
        }
        return !(state.browserPagesByWorkspace[tab.id] ?? []).some((page) => {
          const handle = state.remoteBrowserPageHandlesByPageId[page.id]
          return (
            handle?.environmentId === environmentId &&
            nextRemoteBrowserPageIds.has(handle.remotePageId)
          )
        })
      })
      .map((tab) => tab.id)
  )
  const retainedBrowserTabs = currentBrowserTabs.filter(
    (tab) => !removedBrowserWorkspaceIds.has(tab.id)
  )
  const nextBrowserTabs =
    retainedBrowserTabs.length + mirroredBrowserTabs.length > 0
      ? [...retainedBrowserTabs, ...mirroredBrowserTabs.map((entry) => entry.workspace)]
      : null
  const readyEditorTabs = snapshot.tabs.filter(isReadyEditorTab)
  const worktreeOpenFiles = webSessionOpenFilesForWorktree(state, worktreeId, batchContext)
  const mirroredEditorTabs = buildMirroredEditorTabs(
    snapshot,
    environmentId,
    firstOpenFileByIdForWorktree(worktreeOpenFiles),
    existingTabIndex,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length + mirroredBrowserTabs.length,
    now
  )
  const mirroredEditorFileIds = new Set(mirroredEditorTabs.map((entry) => entry.file.id))
  const mirroredEditorHostTabIds = new Set(mirroredEditorTabs.map((entry) => entry.hostTabId))
  const removedEditorFileIds = new Set(
    worktreeOpenFiles
      .filter(
        (file) =>
          file.runtimeEnvironmentId === environmentId &&
          (file.mode === 'edit' || file.mode === 'markdown-preview') &&
          // Why: only cull host-mirrored tabs; locally opened files have no host counterpart, so their omission isn't a close signal.
          file.mirroredFromRuntimeSession === true &&
          !mirroredEditorFileIds.has(file.id)
      )
      .map((file) => file.id)
  )
  const isReplacedOpenFile = (file: OpenFile): boolean =>
    file.runtimeEnvironmentId === environmentId &&
    (removedEditorFileIds.has(file.id) || mirroredEditorFileIds.has(file.id))
  const replacedOpenFileCount = worktreeOpenFiles.filter(isReplacedOpenFile).length
  // Why: both consumers below ask only about this worktree, so the surviving ids answer
  // them in worktree scope instead of walking every open file in the app.
  const nextWorktreeOpenFileIds = new Set<string>(
    worktreeOpenFiles.filter((file) => !isReplacedOpenFile(file)).map((file) => file.id)
  )
  for (const fileId of mirroredEditorFileIds) {
    nextWorktreeOpenFileIds.add(fileId)
  }
  const mirroredOpenFiles = mirroredEditorTabs.map((entry) => entry.file)
  const nextOpenFiles = (() => {
    // Why: with nothing to drop or mirror, rebuilding reproduces the array exactly, so
    // skip the global rebuild the equality check below would have thrown away anyway.
    if (replacedOpenFileCount === 0 && mirroredOpenFiles.length === 0) {
      return state.openFiles
    }
    const retained = state.openFiles.filter(
      (file) =>
        !(
          file.worktreeId === worktreeId &&
          file.runtimeEnvironmentId === environmentId &&
          (removedEditorFileIds.has(file.id) || mirroredEditorFileIds.has(file.id))
        )
    )
    const next = [...retained, ...mirroredOpenFiles]
    return sameOpenFiles(state.openFiles, next) ? state.openFiles : next
  })()
  advanceWebSessionOpenFilesIndex(batchContext, nextOpenFiles, worktreeId)
  const currentUnifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const retainedUnifiedTabs = currentUnifiedTabs.filter((tab) => {
    if (tab.contentType === 'browser') {
      return (
        !removedBrowserWorkspaceIds.has(tab.entityId) &&
        !mirroredBrowserWorkspaceIds.has(tab.entityId)
      )
    }
    if (tab.contentType === 'editor') {
      return (
        !removedEditorFileIds.has(tab.entityId) &&
        !mirroredEditorFileIds.has(tab.entityId) &&
        !mirroredEditorHostTabIds.has(tab.id)
      )
    }
    if (tab.contentType !== 'terminal') {
      return true
    }
    if (removedTerminalIds.has(tab.entityId) || removedTerminalIds.has(tab.id)) {
      return false
    }
    return !mirroredTerminalIds.has(tab.entityId) && !mirroredTerminalIds.has(tab.id)
  })
  const existingViewModeByTabId = new Map(
    currentUnifiedTabs
      .filter((tab) => tab.contentType === 'terminal' && tab.viewMode)
      .map((tab) => [tab.id, tab.viewMode] as const)
  )
  const mirroredTerminalUnifiedTabs = mirroredTerminalTabs.map((entry) =>
    buildTerminalUnifiedTab(
      entry.tab,
      hostGroupIdByTabId.get(entry.hostTabId) ?? targetGroupId,
      environmentId,
      entry.tab.viewMode ?? existingViewModeByTabId.get(entry.tab.id)
    )
  )
  const mirroredBrowserUnifiedTabs = mirroredBrowserTabs.map((entry) => entry.unifiedTab)
  const mirroredEditorUnifiedTabs = mirroredEditorTabs.map((entry) => entry.unifiedTab)
  const mirroredUnifiedTabs = [
    ...mirroredTerminalUnifiedTabs,
    ...mirroredBrowserUnifiedTabs,
    ...mirroredEditorUnifiedTabs
  ]
  const nextUnifiedTabs =
    retainedUnifiedTabs.length + mirroredUnifiedTabs.length > 0
      ? [...retainedUnifiedTabs, ...mirroredUnifiedTabs]
      : null
  const validUnifiedTabIds = new Set(nextUnifiedTabs?.map((tab) => tab.id) ?? [])
  const activeHostTerminalId =
    terminalSurfaceTabs.find((tab) => tab.id === snapshot.activeTabId)?.id ??
    terminalSurfaceTabs.find((tab) => tab.isActive)?.id ??
    null
  const activeHostTerminalParentId =
    terminalSurfaceTabs.find((tab) => tab.id === activeHostTerminalId)?.parentTabId ??
    terminalSurfaceTabs.find((tab) => tab.isActive)?.parentTabId ??
    null
  const activeMirroredTerminalId = activeHostTerminalId
    ? toWebTerminalSurfaceTabId(activeHostTerminalParentId ?? activeHostTerminalId)
    : null
  const activeHostBrowser =
    readyBrowserTabs.find((tab) => tab.id === snapshot.activeTabId) ??
    readyBrowserTabs.find((tab) => tab.isActive) ??
    null
  const activeMirroredBrowser = activeHostBrowser
    ? (mirroredBrowserTabs.find(
        (entry) => entry.remotePageId === activeHostBrowser.browserPageId
      ) ?? null)
    : null
  const activeMirroredBrowserTabId = activeMirroredBrowser?.unifiedTab.id ?? null
  const activeMirroredBrowserWorkspaceId = activeMirroredBrowser?.workspace.id ?? null
  const activeHostEditor =
    readyEditorTabs.find((tab) => tab.id === snapshot.activeTabId) ??
    readyEditorTabs.find((tab) => tab.isActive) ??
    null
  const activeMirroredEditor = activeHostEditor
    ? (mirroredEditorTabs.find((entry) => entry.hostTabId === activeHostEditor.id) ?? null)
    : null
  const activeMirroredEditorFileId = activeMirroredEditor?.file.id ?? null
  const activeMirroredEditorTabId = activeMirroredEditor?.unifiedTab.id ?? null
  const intentMirroredTerminalId =
    navigationIntentTab?.type === 'terminal'
      ? toWebTerminalSurfaceTabId(navigationIntentTab.parentTabId)
      : null
  const intentMirroredBrowser =
    navigationIntentTab?.type === 'browser'
      ? (mirroredBrowserTabs.find(
          (entry) =>
            entry.hostTabId === navigationIntentTab.id ||
            entry.remotePageId === navigationIntentTab.browserPageId
        ) ?? null)
      : null
  const intentMirroredEditor =
    navigationIntentTab?.type === 'markdown' || navigationIntentTab?.type === 'file'
      ? (mirroredEditorTabs.find((entry) => entry.hostTabId === navigationIntentTab.id) ?? null)
      : null
  const currentActiveTerminalStillExists =
    state.activeTabIdByWorktree[worktreeId] &&
    (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabIdByWorktree[worktreeId])
      ? state.activeTabIdByWorktree[worktreeId]
      : null
  // Why: caller intent targets the requested tab even when an older host leaves its own active tab unchanged.
  const intentTerminalId =
    honorSnapshotActiveFocus && navigationIntentTab?.type === 'terminal'
      ? intentMirroredTerminalId
      : null
  const nextActiveTerminalId =
    intentTerminalId ??
    currentActiveTerminalStillExists ??
    (snapshot.activeTabType === 'terminal'
      ? (activeMirroredTerminalId ?? mirroredTerminalTabEntries[0]?.id)
      : mirroredTerminalTabEntries[0]?.id) ??
    null
  const currentActiveBrowserStillExists =
    state.activeBrowserTabIdByWorktree[worktreeId] &&
    (nextBrowserTabs ?? []).some((tab) => tab.id === state.activeBrowserTabIdByWorktree[worktreeId])
      ? state.activeBrowserTabIdByWorktree[worktreeId]
      : null
  const intentBrowserWorkspaceId =
    honorSnapshotActiveFocus && navigationIntentTab?.type === 'browser'
      ? (intentMirroredBrowser?.workspace.id ?? null)
      : null
  const nextActiveBrowserWorkspaceId =
    intentBrowserWorkspaceId ??
    currentActiveBrowserStillExists ??
    (snapshot.activeTabType === 'browser'
      ? (activeMirroredBrowserWorkspaceId ?? mirroredBrowserTabs[0]?.workspace.id)
      : mirroredBrowserTabs[0]?.workspace.id) ??
    null
  const activeEditorFileIdForWorktree = state.activeFileIdByWorktree[worktreeId]
  const currentActiveEditorStillExists =
    activeEditorFileIdForWorktree && nextWorktreeOpenFileIds.has(activeEditorFileIdForWorktree)
      ? activeEditorFileIdForWorktree
      : null
  const intentEditorFileId = honorSnapshotActiveFocus
    ? (intentMirroredEditor?.file.id ?? null)
    : null
  const nextActiveEditorFileId =
    intentEditorFileId ??
    currentActiveEditorStillExists ??
    (snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? (activeMirroredEditorFileId ?? mirroredEditorTabs[0]?.file.id)
      : mirroredEditorTabs[0]?.file.id) ??
    null
  const currentVisibleUnifiedTabId = resolveWebSessionVisibleTabId(
    state,
    worktreeId,
    nextUnifiedTabs ?? []
  )
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  // Why: Open Preview to the Side can activate an empty reserved group before the host
  // browser lands. A snapshot that still has the host terminal active must not treat
  // that emptiness as a terminal focus change.
  const reservedEmptyPreviewFallbackTabId =
    currentVisibleUnifiedTabId == null &&
    activeGroupId != null &&
    isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId: activeGroupId })
      ? resolveWebSessionSiblingVisibleTabId(state, worktreeId, nextUnifiedTabs ?? [])
      : null
  // Why: a client-initiated activation also drives the visible unified tab, overriding the sticky current-visible tab.
  const intentUnifiedTabId = honorSnapshotActiveFocus
    ? navigationIntentTab?.type === 'browser'
      ? (intentMirroredBrowser?.unifiedTab.id ?? null)
      : navigationIntentTab?.type === 'terminal'
        ? intentTerminalId
        : navigationIntentTab?.type === 'markdown' || navigationIntentTab?.type === 'file'
          ? (intentMirroredEditor?.unifiedTab.id ?? null)
          : null
    : null
  const nextActiveUnifiedTabId =
    intentUnifiedTabId ??
    currentVisibleUnifiedTabId ??
    reservedEmptyPreviewFallbackTabId ??
    (snapshot.activeTabType === 'browser'
      ? (activeMirroredBrowserTabId ??
        mirroredBrowserTabs[0]?.unifiedTab.id ??
        state.activeTabIdByWorktree[worktreeId] ??
        nextActiveTerminalId)
      : snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
        ? (activeMirroredEditorTabId ??
          mirroredEditorTabs[0]?.unifiedTab.id ??
          state.activeTabIdByWorktree[worktreeId] ??
          nextActiveTerminalId)
        : nextActiveTerminalId)
  const mirroredUnifiedIds = new Set(mirroredUnifiedTabs.map((tab) => tab.id))
  const hostToLocalTabId = buildHostToLocalTabIdMap({
    terminalSurfaces: terminalSurfaceTabs,
    terminalTabs: mirroredTerminalTabEntries,
    browserTabs: mirroredBrowserTabs,
    editorTabs: mirroredEditorTabs
  })
  updateHostSessionTabIdMappings({
    environmentId,
    worktreeId,
    terminalSurfaces: terminalSurfaceTabs,
    terminalTabs: mirroredTerminalTabEntries,
    browserTabs: mirroredBrowserTabs,
    editorTabs: mirroredEditorTabs
  })

  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  const clientGroupIdByLocalTabId = new Map(
    mirroredBrowserTabs.flatMap((entry) =>
      entry.clientGroupId ? [[entry.unifiedTab.id, entry.clientGroupId]] : []
    )
  )
  const nextGroups = (() => {
    if (!nextUnifiedTabs || nextUnifiedTabs.length === 0) {
      return null
    }
    if (snapshot.tabGroups && snapshot.tabGroups.length > 0) {
      return buildMirroredHostGroups({
        currentGroups,
        hostGroups: snapshot.tabGroups,
        hostToLocalTabId,
        mirroredUnifiedIds,
        nextActiveUnifiedTabId,
        now,
        validUnifiedTabIds,
        environmentId,
        worktreeId,
        clientGroupIdByLocalTabId
      })
    }
    const strippedGroups = retainClientPlacedMirroredTabs({
      groups: currentGroups,
      mirroredUnifiedIds,
      validUnifiedTabIds,
      clientGroupIdByLocalTabId,
      nextActiveUnifiedTabId
    })
    const target = strippedGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const targetOrder = [
      ...target.tabOrder.filter((tabId) => validUnifiedTabIds.has(tabId)),
      ...mirroredUnifiedTabs
        .filter((tab) => !clientGroupIdByLocalTabId.has(tab.id))
        .map((tab) => tab.id)
    ]
    const targetActiveTabId =
      nextActiveUnifiedTabId && targetOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : target.activeTabId && targetOrder.includes(target.activeTabId)
          ? target.activeTabId
          : (targetOrder[0] ?? null)
    const updatedTarget: TabGroup = {
      ...target,
      worktreeId,
      tabOrder: targetOrder,
      activeTabId: targetActiveTabId,
      recentTabIds: targetActiveTabId
        ? pushRecentTabId(sanitizeRecentTabIds(target.recentTabIds, targetOrder), targetActiveTabId)
        : []
    }
    const merged = strippedGroups.some((group) => group.id === targetGroupId)
      ? strippedGroups.map((group) => (group.id === targetGroupId ? updatedTarget : group))
      : [...strippedGroups, updatedTarget]
    return merged.filter(
      (group) =>
        group.id === targetGroupId ||
        group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({
          worktreeId,
          groupId: group.id
        })
    )
  })()

  const nextTabBarOrder = (() => {
    const current = state.tabBarOrderByWorktree[worktreeId] ?? []
    const validTabBarIds = new Set([
      ...retainedUnifiedTabs.map((tab) => tab.id),
      ...mirroredUnifiedTabs.map((tab) => tab.id)
    ])
    const hostTabBarOrder =
      snapshot.tabGroups?.flatMap((group) =>
        group.tabOrder
          .map((tabId) => hostToLocalTabId.get(tabId))
          .filter((tabId): tabId is string => tabId !== undefined && validTabBarIds.has(tabId))
      ) ?? []
    const next: string[] = []
    const seen = new Set<string>()
    const push = (tabId: string): void => {
      if (validTabBarIds.has(tabId) && !seen.has(tabId)) {
        seen.add(tabId)
        next.push(tabId)
      }
    }
    // Why: snapshots can arrive after the client staged local browser tabs, so preserve visible order and only append new host tabs.
    for (const tabId of current) {
      push(tabId)
    }
    const hostOrMirroredOrder =
      hostTabBarOrder.length > 0 ? hostTabBarOrder : mirroredUnifiedTabs.map((tab) => tab.id)
    for (const tabId of hostOrMirroredOrder) {
      push(tabId)
    }
    return next
  })()

  let nextPtyIdsByTabId = state.ptyIdsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (nextPtyIdsByTabId[removedId]) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId
          ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
          : nextPtyIdsByTabId
      delete nextPtyIdsByTabId[removedId]
    }
  }
  for (const { tab, ptyIds } of mirroredTerminalTabs) {
    if (ptyIds.length === 0) {
      if (nextPtyIdsByTabId[tab.id]) {
        nextPtyIdsByTabId =
          nextPtyIdsByTabId === state.ptyIdsByTabId
            ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
            : nextPtyIdsByTabId
        delete nextPtyIdsByTabId[tab.id]
      }
      continue
    }
    const current = nextPtyIdsByTabId[tab.id] ?? []
    if (!sameStringArray(current, ptyIds)) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId
          ? writableWebSessionTabsRecord(state, 'ptyIdsByTabId', batchContext)
          : nextPtyIdsByTabId
      nextPtyIdsByTabId[tab.id] = ptyIds
    }
  }

  let nextTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  for (const removedId of removedTerminalResourceIds) {
    if (nextTerminalLayoutsByTabId[removedId]) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? writableWebSessionTabsRecord(state, 'terminalLayoutsByTabId', batchContext)
          : nextTerminalLayoutsByTabId
      delete nextTerminalLayoutsByTabId[removedId]
    }
  }
  for (const { tab, layout } of mirroredTerminalTabs) {
    if (!terminalLayoutEqual(nextTerminalLayoutsByTabId[tab.id], layout)) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? writableWebSessionTabsRecord(state, 'terminalLayoutsByTabId', batchContext)
          : nextTerminalLayoutsByTabId
      nextTerminalLayoutsByTabId[tab.id] = layout
    }
  }

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const removedId of removedTerminalIds) {
    if (nextUnreadTerminalTabs[removedId]) {
      nextUnreadTerminalTabs =
        nextUnreadTerminalTabs === state.unreadTerminalTabs
          ? writableWebSessionTabsRecord(state, 'unreadTerminalTabs', batchContext)
          : nextUnreadTerminalTabs
      delete nextUnreadTerminalTabs[removedId]
    }
  }

  const pendingStartupByTabId = state.pendingStartupByTabId ?? {}
  let nextPendingStartupByTabId = pendingStartupByTabId
  const automaticAgentResumeClaimsByTabId = state.automaticAgentResumeClaimsByTabId ?? {}
  let nextAutomaticAgentResumeClaimsByTabId = automaticAgentResumeClaimsByTabId
  for (const removedId of exactProvisionalHandoffs) {
    if (nextPendingStartupByTabId[removedId]) {
      nextPendingStartupByTabId =
        nextPendingStartupByTabId === pendingStartupByTabId
          ? writableWebSessionTabsRecord(state, 'pendingStartupByTabId', batchContext)
          : nextPendingStartupByTabId
      delete nextPendingStartupByTabId[removedId]
    }
    if (nextAutomaticAgentResumeClaimsByTabId[removedId]) {
      nextAutomaticAgentResumeClaimsByTabId =
        nextAutomaticAgentResumeClaimsByTabId === automaticAgentResumeClaimsByTabId
          ? writableWebSessionTabsRecord(state, 'automaticAgentResumeClaimsByTabId', batchContext)
          : nextAutomaticAgentResumeClaimsByTabId
      delete nextAutomaticAgentResumeClaimsByTabId[removedId]
    }
  }

  let nextBrowserPagesByWorkspace = state.browserPagesByWorkspace
  let nextRemoteBrowserPageHandlesByPageId = state.remoteBrowserPageHandlesByPageId
  let nextBrowserCertificateFailuresByPageId = state.browserCertificateFailuresByPageId
  if (removedBrowserWorkspaceIds.size > 0) {
    const nextBrowserWorkspaceIds = new Set(nextBrowserTabs?.map((tab) => tab.id) ?? [])
    const nextBrowserPageIds = new Set(mirroredBrowserTabs.map((entry) => entry.page.id))
    for (const workspace of retainedBrowserTabs) {
      for (const page of state.browserPagesByWorkspace[workspace.id] ?? []) {
        nextBrowserPageIds.add(page.id)
      }
    }
    for (const removedWorkspaceId of removedBrowserWorkspaceIds) {
      const pages = nextBrowserPagesByWorkspace[removedWorkspaceId] ?? []
      if (
        !nextBrowserWorkspaceIds.has(removedWorkspaceId) &&
        nextBrowserPagesByWorkspace[removedWorkspaceId]
      ) {
        nextBrowserPagesByWorkspace =
          nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
            ? writableWebSessionTabsRecord(state, 'browserPagesByWorkspace', batchContext)
            : nextBrowserPagesByWorkspace
        delete nextBrowserPagesByWorkspace[removedWorkspaceId]
      }
      for (const page of pages) {
        if (nextBrowserPageIds.has(page.id)) {
          continue
        }
        if (nextBrowserCertificateFailuresByPageId[page.id]) {
          nextBrowserCertificateFailuresByPageId =
            nextBrowserCertificateFailuresByPageId === state.browserCertificateFailuresByPageId
              ? writableWebSessionTabsRecord(
                  state,
                  'browserCertificateFailuresByPageId',
                  batchContext
                )
              : nextBrowserCertificateFailuresByPageId
          delete nextBrowserCertificateFailuresByPageId[page.id]
        }
        if (nextRemoteBrowserPageHandlesByPageId[page.id]) {
          nextRemoteBrowserPageHandlesByPageId =
            nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
              ? writableWebSessionTabsRecord(
                  state,
                  'remoteBrowserPageHandlesByPageId',
                  batchContext
                )
              : nextRemoteBrowserPageHandlesByPageId
          delete nextRemoteBrowserPageHandlesByPageId[page.id]
        }
      }
    }
  }
  for (const { page, certificateFailure, remotePageId } of mirroredBrowserTabs) {
    const current = nextBrowserPagesByWorkspace[page.workspaceId] ?? []
    if (!sameBrowserPages(current, [page])) {
      nextBrowserPagesByWorkspace =
        nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
          ? writableWebSessionTabsRecord(state, 'browserPagesByWorkspace', batchContext)
          : nextBrowserPagesByWorkspace
      nextBrowserPagesByWorkspace[page.workspaceId] = [page]
    }
    const currentHandle = nextRemoteBrowserPageHandlesByPageId[page.id]
    if (
      currentHandle?.environmentId !== environmentId ||
      currentHandle.remotePageId !== remotePageId
    ) {
      nextRemoteBrowserPageHandlesByPageId =
        nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
          ? writableWebSessionTabsRecord(state, 'remoteBrowserPageHandlesByPageId', batchContext)
          : nextRemoteBrowserPageHandlesByPageId
      nextRemoteBrowserPageHandlesByPageId[page.id] = {
        environmentId,
        remotePageId
      }
    }
    if (
      !browserCertificateFailureEqual(
        nextBrowserCertificateFailuresByPageId[page.id],
        certificateFailure
      )
    ) {
      nextBrowserCertificateFailuresByPageId =
        nextBrowserCertificateFailuresByPageId === state.browserCertificateFailuresByPageId
          ? writableWebSessionTabsRecord(state, 'browserCertificateFailuresByPageId', batchContext)
          : nextBrowserCertificateFailuresByPageId
      if (certificateFailure) {
        nextBrowserCertificateFailuresByPageId[page.id] = certificateFailure
      } else {
        delete nextBrowserCertificateFailuresByPageId[page.id]
      }
    }
  }

  const nextTabsByWorktree = withWorktreeEntry(
    state,
    'tabsByWorktree',
    worktreeId,
    nextTerminalTabs,
    sameTerminalTabs,
    batchContext
  )
  const nextBrowserTabsByWorktree = withWorktreeEntry(
    state,
    'browserTabsByWorktree',
    worktreeId,
    nextBrowserTabs,
    sameBrowserTabs,
    batchContext
  )
  const nextUnifiedTabsByWorktree = withWorktreeEntry(
    state,
    'unifiedTabsByWorktree',
    worktreeId,
    nextUnifiedTabs,
    sameUnifiedTabs,
    batchContext
  )
  const nextGroupsByWorktree = withWorktreeEntry(
    state,
    'groupsByWorktree',
    worktreeId,
    nextGroups,
    sameGroups,
    batchContext
  )
  const nextActiveGroupId =
    // Why: status/title snapshots carry the host's last active tab; a client that already switched panes keeps its local group focus.
    nextGroups?.find((group) => group.activeTabId === nextActiveUnifiedTabId)?.id ??
    nextGroups?.find((group) => group.id === snapshot.activeGroupId)?.id ??
    nextGroups?.[0]?.id ??
    null
  const nextActiveGroupIdByWorktree =
    nextGroups && state.activeGroupIdByWorktree[worktreeId] !== nextActiveGroupId
      ? withWorktreeEntry(
          state,
          'activeGroupIdByWorktree',
          worktreeId,
          nextActiveGroupId ?? targetGroupId,
          (current, next) => current === next,
          batchContext
        )
      : state.activeGroupIdByWorktree
  const nextLayoutByWorktree = (() => {
    if (!nextGroups) {
      return state.layoutByWorktree
    }
    const validGroupIds = new Set(nextGroups.map((group) => group.id))
    const hostLayout = pruneTabGroupLayout(snapshot.tabGroupLayout, validGroupIds)
    const defaultLeafLayout = { type: 'leaf' as const, groupId: nextActiveGroupId ?? targetGroupId }
    const hostLayoutGroupIds = collectLayoutGroupIds(hostLayout ?? undefined)
    const hostGroupIds = new Set(snapshot.tabGroups?.map((group) => group.id) ?? [])
    const extraGroupIds = new Set(
      nextGroups
        .map((group) => group.id)
        .filter((groupId) =>
          hostLayout
            ? !hostLayoutGroupIds.has(groupId)
            : snapshot.tabGroups && snapshot.tabGroups.length > 0
              ? !hostGroupIds.has(groupId)
              : false
        )
    )
    const localExtraLayout = pruneTabGroupLayout(state.layoutByWorktree[worktreeId], extraGroupIds)
    const hostBaseLayout =
      hostLayout ?? (snapshot.tabGroups && snapshot.tabGroups.length > 0 ? defaultLeafLayout : null)
    const fallbackLayout =
      appendTabGroupLayout(hostBaseLayout, localExtraLayout) ??
      (snapshot.tabGroups && snapshot.tabGroups.length > 0
        ? defaultLeafLayout
        : state.layoutByWorktree[worktreeId]
          ? null
          : defaultLeafLayout)
    if (!fallbackLayout) {
      return state.layoutByWorktree
    }
    if (tabGroupLayoutEqual(state.layoutByWorktree[worktreeId], fallbackLayout)) {
      return state.layoutByWorktree
    }
    return withWorktreeEntry(
      state,
      'layoutByWorktree',
      worktreeId,
      fallbackLayout,
      (current, next) => current === next,
      batchContext
    )
  })()
  const nextTabBarOrderByWorktree = withWorktreeEntry(
    state,
    'tabBarOrderByWorktree',
    worktreeId,
    nextTabBarOrder.length > 0 ? nextTabBarOrder : null,
    (a, b) => sameStringArray(a ?? [], b ?? []),
    batchContext
  )
  const nextActiveTabIdByWorktree =
    (state.activeTabIdByWorktree[worktreeId] ?? null) !== nextActiveTerminalId
      ? withWorktreeEntry(
          state,
          'activeTabIdByWorktree',
          worktreeId,
          nextActiveTerminalId,
          (current, next) => (current ?? null) === next,
          batchContext,
          false
        )
      : state.activeTabIdByWorktree
  const nextActiveBrowserTabIdByWorktree =
    (state.activeBrowserTabIdByWorktree[worktreeId] ?? null) !== nextActiveBrowserWorkspaceId
      ? withWorktreeEntry(
          state,
          'activeBrowserTabIdByWorktree',
          worktreeId,
          nextActiveBrowserWorkspaceId,
          (current, next) => (current ?? null) === next,
          batchContext,
          false
        )
      : state.activeBrowserTabIdByWorktree
  const nextActiveFileIdByWorktree =
    (state.activeFileIdByWorktree[worktreeId] ?? null) !== nextActiveEditorFileId
      ? withWorktreeEntry(
          state,
          'activeFileIdByWorktree',
          worktreeId,
          nextActiveEditorFileId,
          (current, next) => (current ?? null) === next,
          batchContext,
          false
        )
      : state.activeFileIdByWorktree
  const isActiveWorktree = state.activeWorktreeId === worktreeId
  const focusIntentVisibleTabType =
    navigationIntentTab?.type === 'browser' && intentBrowserWorkspaceId
      ? ('browser' as const)
      : navigationIntentTab?.type === 'terminal' && intentTerminalId
        ? ('terminal' as const)
        : intentEditorFileId
          ? ('editor' as const)
          : null
  const snapshotVisibleTabType =
    snapshot.activeTabType === 'browser' && nextActiveBrowserWorkspaceId
      ? ('browser' as const)
      : snapshot.activeTabType === 'terminal' && nextActiveTerminalId
        ? ('terminal' as const)
        : (snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file') &&
            nextActiveEditorFileId
          ? ('editor' as const)
          : null
  const currentVisibleTabType =
    state.activeTabTypeByWorktree[worktreeId] ?? (isActiveWorktree ? state.activeTabType : null)
  const currentVisibleTabTypeStillValid =
    currentVisibleTabType === 'browser' && currentActiveBrowserStillExists
      ? ('browser' as const)
      : currentVisibleTabType === 'editor' && currentActiveEditorStillExists
        ? ('editor' as const)
        : currentVisibleTabType === 'terminal' && currentActiveTerminalStillExists
          ? ('terminal' as const)
          : null
  const activeUnifiedTab =
    nextActiveUnifiedTabId && nextUnifiedTabs
      ? (nextUnifiedTabs.find((tab) => tab.id === nextActiveUnifiedTabId) ?? null)
      : null
  const fallbackVisibleTabType =
    activeUnifiedTab !== null
      ? toVisibleTabType(activeUnifiedTab)
      : nextActiveTerminalId
        ? ('terminal' as const)
        : nextActiveBrowserWorkspaceId
          ? ('browser' as const)
          : nextActiveEditorFileId
            ? ('editor' as const)
            : ('terminal' as const)
  // Why: don't keep pointing shortcuts at a removed browser/editor; a client-initiated activation lets the snapshot's type switch the visible pane.
  const nextVisibleTabType = honorSnapshotActiveFocus
    ? (focusIntentVisibleTabType ??
      currentVisibleTabTypeStillValid ??
      snapshotVisibleTabType ??
      fallbackVisibleTabType)
    : (currentVisibleTabTypeStillValid ?? snapshotVisibleTabType ?? fallbackVisibleTabType)
  const currentActiveTerminalStillValid =
    state.activeTabId && (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : null
  const currentActiveEditorStillValid =
    state.activeFileId && nextWorktreeOpenFileIds.has(state.activeFileId)
      ? state.activeFileId
      : null
  const nextActiveTabId = isActiveWorktree
    ? snapshot.activeTabType === 'terminal'
      ? nextActiveTerminalId
      : (currentActiveTerminalStillValid ?? nextActiveTerminalId)
    : state.activeTabId
  const nextActiveBrowserTabId = isActiveWorktree
    ? nextActiveBrowserWorkspaceId
    : state.activeBrowserTabId
  const nextActiveFileId = isActiveWorktree
    ? snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? nextActiveEditorFileId
      : (currentActiveEditorStillValid ?? nextActiveEditorFileId)
    : state.activeFileId
  const nextActiveTabType = isActiveWorktree ? nextVisibleTabType : state.activeTabType
  const nextActiveTabTypeByWorktree =
    state.activeTabTypeByWorktree[worktreeId] !== nextVisibleTabType
      ? withWorktreeEntry(
          state,
          'activeTabTypeByWorktree',
          worktreeId,
          nextVisibleTabType,
          (current, next) => current === next,
          batchContext
        )
      : state.activeTabTypeByWorktree
  const agentStatusPatch = buildMirroredAgentStatusPatch(
    state,
    currentTerminalTabs,
    terminalSurfaceTabs,
    mirroredTerminalTabs,
    now,
    batchContext
  )
  // Why: only a host snapshot that omits a tab is a retraction; a tombstone clears the mirror
  // for every environment at once, and sweeping there erases rows a live sibling still owns.
  const retractedTabSweepPatch = isWebSessionTabsWorktreeRemovalFrame(snapshot)
    ? null
    : buildRetractedMirroredTabSweepPatch(
        state,
        worktreeId,
        nextTabsByWorktree,
        agentStatusPatch,
        removedTerminalResourceIds,
        batchContext
      )
  // Why: mirrored ids are stable, so a published-again id proves the tab is not closed —
  // a lingering closed-tab marker would blackhole its byte-derived status for the whole
  // session (host-restart subset frames, cross-host collision replays). The close-intent
  // filter already holds genuinely closing tabs out of the snapshot.
  const remirroredClosedTabLiftPatch = buildRemirroredClosedTabMarkerLiftPatch(
    retractedTabSweepPatch?.recentlyClosedAgentStatusTabIds ??
      state.recentlyClosedAgentStatusTabIds,
    mirroredTerminalIds
  )

  const patch: Partial<WebSessionTabsSyncState> = {
    ...agentStatusPatch,
    ...retractedTabSweepPatch,
    ...remirroredClosedTabLiftPatch,
    ...(nextOpenFiles !== state.openFiles ? { openFiles: nextOpenFiles } : {}),
    ...(nextTabsByWorktree !== state.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
    ...(nextBrowserTabsByWorktree !== state.browserTabsByWorktree
      ? { browserTabsByWorktree: nextBrowserTabsByWorktree }
      : {}),
    ...(nextUnifiedTabsByWorktree !== state.unifiedTabsByWorktree
      ? { unifiedTabsByWorktree: nextUnifiedTabsByWorktree }
      : {}),
    ...(nextGroupsByWorktree !== state.groupsByWorktree
      ? { groupsByWorktree: nextGroupsByWorktree }
      : {}),
    ...(nextActiveGroupIdByWorktree !== state.activeGroupIdByWorktree
      ? { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }
      : {}),
    ...(nextLayoutByWorktree !== state.layoutByWorktree
      ? { layoutByWorktree: nextLayoutByWorktree }
      : {}),
    ...(nextTabBarOrderByWorktree !== state.tabBarOrderByWorktree
      ? { tabBarOrderByWorktree: nextTabBarOrderByWorktree }
      : {}),
    ...(nextPtyIdsByTabId !== state.ptyIdsByTabId ? { ptyIdsByTabId: nextPtyIdsByTabId } : {}),
    ...(nextTerminalLayoutsByTabId !== state.terminalLayoutsByTabId
      ? { terminalLayoutsByTabId: nextTerminalLayoutsByTabId }
      : {}),
    ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
      ? { unreadTerminalTabs: nextUnreadTerminalTabs }
      : {}),
    ...(nextPendingStartupByTabId !== pendingStartupByTabId
      ? { pendingStartupByTabId: nextPendingStartupByTabId }
      : {}),
    ...(nextAutomaticAgentResumeClaimsByTabId !== automaticAgentResumeClaimsByTabId
      ? { automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId }
      : {}),
    ...(nextBrowserPagesByWorkspace !== state.browserPagesByWorkspace
      ? { browserPagesByWorkspace: nextBrowserPagesByWorkspace }
      : {}),
    ...(nextRemoteBrowserPageHandlesByPageId !== state.remoteBrowserPageHandlesByPageId
      ? { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
      : {}),
    ...(nextBrowserCertificateFailuresByPageId !== state.browserCertificateFailuresByPageId
      ? { browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId }
      : {}),
    ...(nextActiveTabIdByWorktree !== state.activeTabIdByWorktree
      ? { activeTabIdByWorktree: nextActiveTabIdByWorktree }
      : {}),
    ...(nextActiveBrowserTabIdByWorktree !== state.activeBrowserTabIdByWorktree
      ? { activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree }
      : {}),
    ...(nextActiveFileIdByWorktree !== state.activeFileIdByWorktree
      ? { activeFileIdByWorktree: nextActiveFileIdByWorktree }
      : {}),
    ...(nextActiveTabId !== state.activeTabId ? { activeTabId: nextActiveTabId } : {}),
    ...(nextActiveBrowserTabId !== state.activeBrowserTabId
      ? { activeBrowserTabId: nextActiveBrowserTabId }
      : {}),
    ...(nextActiveFileId !== state.activeFileId ? { activeFileId: nextActiveFileId } : {}),
    ...(nextActiveTabType !== state.activeTabType ? { activeTabType: nextActiveTabType } : {}),
    ...(nextActiveTabTypeByWorktree !== state.activeTabTypeByWorktree
      ? { activeTabTypeByWorktree: nextActiveTabTypeByWorktree }
      : {})
  }

  return Object.keys(patch).length === 0 ? state : patch
}

export function applyWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return applyWebSessionTabsSnapshotWithContext(state, rawSnapshot, environmentId, now)
}

export function applyWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const nextState = { ...state }
  const batchContext: WebSessionTabsBatchContext = {
    agentPaneKeysByTabId: null,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const snapshot of snapshots) {
    const patch = applyWebSessionTabsSnapshotWithContext(
      nextState,
      snapshot,
      environmentId,
      now,
      batchContext
    )
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    Object.assign(nextState, patch)
  }
  const mutableMergedPatch = mergedPatch as Record<string, unknown>
  const mutableNextState = nextState as unknown as Record<string, unknown>
  for (const recordKey of batchContext.changedRecords) {
    mutableMergedPatch[recordKey] = mutableNextState[recordKey]
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}

export function applyFreshWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (!shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)) {
    return state
  }
  return applyWebSessionTabsSnapshot(state, snapshot, environmentId, now)
}

export function applyFreshWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const freshSnapshots = snapshots.filter((snapshot) =>
    shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
  )
  return freshSnapshots.length === 0
    ? state
    : applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId, now)
}

type WebSessionTabsSnapshotOperation = {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
}

type DecidedWebSessionTabsSnapshotOperation = WebSessionTabsSnapshotOperation & {
  decision: WebSessionTabsSnapshotDecision
}

/** Why: the settle must name the decision the apply ran on, so each operation
 *  is decided once here instead of again inside the store updater. */
function decideWebSessionTabsSnapshotOperations(
  operations: readonly WebSessionTabsSnapshotOperation[]
): DecidedWebSessionTabsSnapshotOperation[] {
  return operations.map((operation) => ({
    ...operation,
    decision: decideWebSessionTabsSnapshot(operation.snapshot, operation.environmentId)
  }))
}

function applyWebSessionTabsSnapshotOperations(
  state: WebSessionTabsSyncState,
  operations: readonly DecidedWebSessionTabsSnapshotOperation[]
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  let nextState = state
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const { environmentId, snapshot, decision } of operations) {
    if (!decision.apply) {
      continue
    }
    const patch = applyWebSessionTabsSnapshot(nextState, snapshot, environmentId)
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    nextState = { ...nextState, ...patch }
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}

/** Proof that a session-tabs store patch committed. Invoke it after the
 *  frame's finishRecovery to settle the mirror latch for its verdicts. */
export type HostSessionMirrorSettle = () => void

/** A worktree the patch carried, named with the decision its frame's fate came
 *  from. Requiring the decision is the point: a settle cannot be written for a
 *  pair whose frame was never decided, so no site can overstate its evidence. */
export type HostSessionMirrorPatchFrame = {
  environmentId: string
  worktreeId: string
  decision: WebSessionTabsSnapshotDecision
}

/**
 * The host verdicts a store patch carries. Every frame it touched is listed;
 * only the ones whose decision carries `settlesHostMirror` settle, so a frame
 * the patch wrote no bytes for settles ONLY when the store already holds an
 * equal/newer accepted view of it. `fullInventory` upgrades a completely
 * applied inventory to an environment-wide verdict: absence from it is itself
 * the host answering, but a partial one speaks only for the worktrees whose
 * frames reached the store — the rest wait for the next clean inventory rather
 * than read as retracted.
 */
export type HostSessionMirrorPatchVerdict = {
  frames: readonly HostSessionMirrorPatchFrame[]
  fullInventory?: { environmentId: string; publishedSnapshotCount: number }
}

function createHostSessionMirrorSettle(
  verdict: HostSessionMirrorPatchVerdict
): HostSessionMirrorSettle {
  return () => {
    const { frames, fullInventory } = verdict
    const settles = frames.filter(({ decision }) => decision.settlesHostMirror)
    if (fullInventory && settles.length === fullInventory.publishedSnapshotCount) {
      markHostSessionMirrorHydrated(fullInventory.environmentId)
      return
    }
    for (const { environmentId, worktreeId } of settles) {
      markHostSessionMirrorWorktreeHydrated(environmentId, worktreeId)
    }
  }
}

/** The settle a frame earns when its own patch wrote nothing — or null when it
 *  earns none. Only a decision carrying `settlesHostMirror` may stand in for a
 *  patch: it is backed by the equal/newer view already accepted into the store,
 *  so the host HAS answered for this worktree. Taking the decision as the
 *  argument is the point — a new rejection branch cannot inherit a settle by
 *  defaulting, and a transport failure is `unverifiable` and never gets here. */
function hostSessionMirrorSettleForPatchlessFrame(
  decision: WebSessionTabsSnapshotDecision,
  environmentId: string,
  worktreeId: string
): HostSessionMirrorSettle | null {
  return decision.settlesHostMirror
    ? () => markHostSessionMirrorWorktreeHydrated(environmentId, worktreeId)
    : null
}

export function applyWebSessionTabsStorePatch(
  buildPatch: (state: AppState) => WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  hostMirrorVerdict: HostSessionMirrorPatchVerdict,
  agentStatusSnapshots?: RuntimeMobileSessionTabsResult | readonly RuntimeMobileSessionTabsResult[],
  allowCompletionNotification = false
): HostSessionMirrorSettle {
  let mirroredAgentStatusChanged = false
  // Why: zustand commits before notifying subscribers, so a producer that ran
  // to completion has landed even when a subscriber throws afterwards.
  let patchCommitted = false
  const acceptedNotificationStatuses: {
    paneKey: string
    worktreeId: string
    seedOnly?: true
    payload: ReturnType<typeof pickParsedAgentStatusPayload> & {
      stateStartedAt: number
      localStateStartedAt?: number
    }
  }[] = []
  const runStorePatch = (
    state: AppState
  ): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> => {
    const patch = buildPatch(state)
    mirroredAgentStatusChanged = patch !== state && Object.hasOwn(patch, 'agentStatusByPaneKey')
    if (agentStatusSnapshots) {
      const nextAgentStatuses = patch.agentStatusByPaneKey ?? state.agentStatusByPaneKey
      const snapshots = Array.isArray(agentStatusSnapshots)
        ? agentStatusSnapshots
        : [agentStatusSnapshots]
      for (const snapshot of snapshots) {
        for (const surface of snapshot.tabs) {
          if (surface.type !== 'terminal') {
            continue
          }
          const remapped = remapHostAgentStatus(surface)
          const accepted = remapped ? nextAgentStatuses[remapped.paneKey] : undefined
          const turnCompletedAt = remapped
            ? normalizeTurnCompletedAtField(surface.turnCompletedAt, remapped.state)
            : undefined
          if (remapped?.state === 'done' && turnCompletedAt === undefined) {
            hostWorkingClientBoundaryByPaneKey.delete(remapped.paneKey)
          }
          // Why: client OSC owns display state, but only the host hook stream carries background-turn stamps.
          const clientOwnedNotification = Boolean(
            remapped &&
            isClientAuthoritativeAgentStatusPane(remapped.paneKey) &&
            (remapped.state === 'working' || turnCompletedAt !== undefined)
          )
          if (
            !remapped ||
            (!clientOwnedNotification &&
              (!accepted ||
                accepted === state.agentStatusByPaneKey[remapped.paneKey] ||
                !agentStatusEntryEqual(accepted, remapped)))
          ) {
            continue
          }
          const notificationStatus = clientOwnedNotification ? remapped : accepted
          if (!notificationStatus) {
            continue
          }
          const currentClientStateStartedAt = clientOwnedNotification
            ? state.agentStatusByPaneKey[notificationStatus.paneKey]?.stateStartedAt
            : undefined
          let localStateStartedAt = currentClientStateStartedAt
          if (
            clientOwnedNotification &&
            notificationStatus.state === 'working' &&
            currentClientStateStartedAt !== undefined
          ) {
            if (turnCompletedAt === undefined) {
              const retainedBoundary = hostWorkingClientBoundaryByPaneKey.get(
                notificationStatus.paneKey
              )
              if (
                !retainedBoundary ||
                retainedBoundary.hostStateStartedAt !== notificationStatus.stateStartedAt ||
                retainedBoundary.hostPrompt !== notificationStatus.prompt ||
                retainedBoundary.stamped
              ) {
                hostWorkingClientBoundaryByPaneKey.delete(notificationStatus.paneKey)
                hostWorkingClientBoundaryByPaneKey.set(notificationStatus.paneKey, {
                  hostStateStartedAt: notificationStatus.stateStartedAt,
                  hostPrompt: notificationStatus.prompt,
                  clientStateStartedAt: currentClientStateStartedAt,
                  stamped: false
                })
                if (hostWorkingClientBoundaryByPaneKey.size > HOST_WORKING_CLIENT_BOUNDARY_LIMIT) {
                  const oldestPaneKey = hostWorkingClientBoundaryByPaneKey.keys().next().value
                  if (oldestPaneKey !== undefined) {
                    hostWorkingClientBoundaryByPaneKey.delete(oldestPaneKey)
                  }
                }
              }
            } else {
              const retainedBoundary = hostWorkingClientBoundaryByPaneKey.get(
                notificationStatus.paneKey
              )
              if (
                retainedBoundary?.hostStateStartedAt === notificationStatus.stateStartedAt &&
                retainedBoundary.hostPrompt === notificationStatus.prompt
              ) {
                localStateStartedAt = retainedBoundary.clientStateStartedAt
                retainedBoundary.stamped = true
              }
            }
          }
          if (!allowCompletionNotification && notificationStatus.state !== 'working') {
            continue
          }
          acceptedNotificationStatuses.push({
            paneKey: notificationStatus.paneKey,
            worktreeId: notificationStatus.worktreeId ?? snapshot.worktree,
            ...(!allowCompletionNotification ? { seedOnly: true as const } : {}),
            payload: {
              ...pickParsedAgentStatusPayload({
                ...notificationStatus,
                ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {})
              }),
              stateStartedAt: notificationStatus.stateStartedAt,
              ...(clientOwnedNotification
                ? {
                    localStateStartedAt
                  }
                : {})
            }
          })
        }
      }
    }
    patchCommitted = true
    return patch
  }
  try {
    useAppStore.setState(runStorePatch)
  } catch (error) {
    if (!patchCommitted) {
      throw error
    }
    console.warn('[web-session-tabs-sync] a store subscriber failed after the patch landed:', error)
  }
  // Why: the receipt exists exactly from the commit on, so no caller can settle
  // evidence the store does not hold, and none can lose one it does.
  const settleHostMirror = createHostSessionMirrorSettle(hostMirrorVerdict)
  try {
    // Why: paired-web snapshots bypass setAgentStatus, so arm the stale-boundary timer explicitly like local hook events do.
    if (mirroredAgentStatusChanged) {
      useAppStore.getState().scheduleAgentStatusFreshness()
    }
    for (const status of acceptedNotificationStatuses) {
      observeAgentHookCompletionForNotification(status)
    }
  } catch (error) {
    // Why: notification bookkeeping cannot un-land the patch, so it must not
    // destroy the settle receipt of evidence already in the store.
    console.warn('[web-session-tabs-sync] post-patch bookkeeping failed:', error)
  }
  return settleHostMirror
}

function loadInitialWebSessionTabs(
  environmentId: string,
  expectedEnvironmentPairingRevision: number | undefined,
  isCurrent: () => boolean
): void {
  // Why: only a conclusion that reached the store may settle the mirror, so
  // this stays null on every failure exit below.
  let settleHydration: (() => void) | null = null
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'session.tabs.listAll',
      params: {},
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision
    })
    .then(async (response: RuntimeRpcResponse<unknown>) => {
      if (
        !isCurrent() ||
        getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
      ) {
        return
      }
      if (response.ok === false) {
        console.warn('[web-session-tabs-sync] initial listAll failed:', response.error.message)
        return
      }
      const result = response.result
      if (!isSessionTabsListAllResult(result)) {
        console.warn('[web-session-tabs-sync] initial listAll returned an invalid payload')
        return
      }
      const receivedFrames = result.snapshots.map((snapshot) =>
        recordReceivedWebSessionTabsSnapshot(environmentId, snapshot)
      )
      const finishRecoveries = result.snapshots.map((snapshot, index) =>
        beginWebSessionTabsSnapshotRecovery(
          environmentId,
          snapshot.worktree,
          receivedFrames[index]!
        )
      )
      try {
        const recovered = await Promise.all(
          result.snapshots.map((snapshot) =>
            recoverWebSessionTerminalOrphansBeforeApply(
              useAppStore.getState(),
              snapshot,
              environmentId
            )
          )
        )
        if (
          !isCurrent() ||
          getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
        ) {
          return
        }
        const applicable = recovered.filter(
          (snapshot, index): snapshot is RuntimeMobileSessionTabsResult =>
            snapshot !== null &&
            shouldApplyRecoveredWebSessionTabsSnapshot(
              environmentId,
              snapshot,
              receivedFrames[index]!
            )
        )
        const decisions = applicable.map((snapshot) =>
          decideWebSessionTabsSnapshot(snapshot, environmentId)
        )
        const freshSnapshots = applicable.filter(
          (_snapshot, position) => decisions[position]!.apply
        )
        settleHydration = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId),
          {
            frames: applicable.map((snapshot, position) => ({
              environmentId,
              worktreeId: snapshot.worktree,
              decision: decisions[position]!
            })),
            fullInventory: {
              environmentId,
              // Why: a workspace the mirror never writes is not part of the
              // inventory the environment-wide verdict has to account for.
              publishedSnapshotCount: result.snapshots.filter((snapshot) =>
                isHostMirroredWorktree(snapshot.worktree)
              ).length
            }
          },
          applicable
        )
      } finally {
        for (const finishRecovery of finishRecoveries) {
          finishRecovery()
        }
      }
    })
    .catch((error) => {
      if (isCurrent()) {
        console.warn(
          '[web-session-tabs-sync] failed to load initial session tabs:',
          error instanceof Error ? error.message : String(error)
        )
      }
    })
    .finally(() => {
      // Why: a rejected or timed-out inventory is `unverifiable`, never proof a
      // host-owned PTY exited, and this latch releases into replaying a resume.
      // Parked work waits for the next inventory instead.
      if (
        isCurrent() &&
        getRuntimeEnvironmentRevision(environmentId) === expectedEnvironmentPairingRevision
      ) {
        settleHydration?.()
      }
    })
}

export function useWebSessionTabsSync(): void {
  const recordVisibilityResumeSnapshotRef = useRef<
    (environmentId: string, snapshot: RuntimeMobileSessionTabsResult, receivedFrame: number) => void
  >(() => {})
  const recordVisibilityResumeSnapshotReceiptRef = useRef<
    (environmentId: string, snapshot: RuntimeMobileSessionTabsResult, receivedFrame: number) => void
  >(() => {})
  const shouldApplyVisibilityResumeSnapshotRef = useRef<
    (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number
    ) => boolean
  >(() => true)
  const visibilityResumeOmissionsByKeyRef = useRef(new Map<string, VisibilityResumeOmission>())
  const mirroredSessionTabsOwnerRevisionByEnvironmentRef = useRef(
    new Map<string, number | undefined>()
  )
  const activeRuntimeEnvironmentIdRef = useRef<string | null>(null)
  const activeRuntimeWorktreeKeyRef = useRef<string | null>(null)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const runtimeSessionMirrorEnvironmentKey = useRuntimeSessionMirrorEnvironmentKey()
  const activeWorktreeRuntimeEnvironmentId = useAppStore((state) =>
    getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
  )
  const activeWorktreeRuntimeId = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId ?? null)
      : null
  })
  const activeWorktreeRuntimeConnectionGeneration = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.connectionGeneration ?? 0)
      : 0
  })
  const activeWorktreeRuntimePairingRevision = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    const environment = state.runtimeEnvironments.find(
      (candidate) => candidate.id === environmentId
    )
    return environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
  })
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  // Why: only resume callbacks read these refs, and resumes fire from visibilitychange or
  // stale-visibility recovery — outside React — so committing during layout leaves no window
  // where a resume could read the previous worktree's key.
  useLayoutEffect(() => {
    activeRuntimeEnvironmentIdRef.current = activeWorktreeRuntimeEnvironmentId?.trim() || null
    activeRuntimeWorktreeKeyRef.current =
      activeWorktreeRuntimeEnvironmentId && activeWorktreeId
        ? sessionTabsFreshnessKey(activeWorktreeRuntimeEnvironmentId, activeWorktreeId)
        : null
  }, [activeWorktreeId, activeWorktreeRuntimeEnvironmentId])

  useEffect(
    () => () => {
      for (const environmentId of mirroredSessionTabsOwnerRevisionByEnvironmentRef.current.keys()) {
        clearWebSessionTabsTrackingForEnvironment(environmentId)
      }
      mirroredSessionTabsOwnerRevisionByEnvironmentRef.current.clear()
      visibilityResumeOmissionsByKeyRef.current.clear()
    },
    []
  )

  useEffect(() => {
    const environments = runtimeSessionMirrorEnvironmentKey
      ? runtimeSessionMirrorEnvironmentKey
          .split('\u0000')
          .map((entry) => {
            const [environmentId = '', , , rawRevision = ''] = entry.split('\u0001')
            return {
              environmentId,
              expectedEnvironmentPairingRevision:
                rawRevision === '' ? undefined : Number(rawRevision)
            }
          })
          .filter(({ environmentId }) => environmentId.trim())
      : []
    const mirroredEnvironmentOwnerRevisions = new Map(
      (workspaceSessionReady ? environments : []).map(
        ({ environmentId, expectedEnvironmentPairingRevision }) =>
          [environmentId, expectedEnvironmentPairingRevision] as const
      )
    )
    const previousOwnerRevisions = mirroredSessionTabsOwnerRevisionByEnvironmentRef.current
    // Why: same-owner tracking must survive effect restarts to reconcile removals missed while hidden.
    for (const [environmentId, previousRevision] of previousOwnerRevisions) {
      if (
        !mirroredEnvironmentOwnerRevisions.has(environmentId) ||
        mirroredEnvironmentOwnerRevisions.get(environmentId) !== previousRevision
      ) {
        clearWebSessionTabsTrackingForEnvironment(environmentId)
      }
    }
    mirroredSessionTabsOwnerRevisionByEnvironmentRef.current = mirroredEnvironmentOwnerRevisions
    for (const [key, omission] of visibilityResumeOmissionsByKeyRef.current) {
      const previousRevision = previousOwnerRevisions.get(omission.environmentId)
      if (
        !mirroredEnvironmentOwnerRevisions.has(omission.environmentId) ||
        (previousOwnerRevisions.has(omission.environmentId) &&
          mirroredEnvironmentOwnerRevisions.get(omission.environmentId) !== previousRevision)
      ) {
        visibilityResumeOmissionsByKeyRef.current.delete(key)
      }
    }
    // Why: mirror all paired runtimes' sessions, not just the selected worktree, so background worktrees don't look asleep (selectedness isn't liveness).
    // Why: applying the host snapshot before startup hydration writes browser-local session state clobbers it and leaves the sidebar stale.
    if (!workspaceSessionReady || environments.length === 0) {
      return
    }

    type VisibilityResumeEnvironment = {
      trackedWorktrees: readonly TrackedWebSessionTabsWorktree[]
      inventoryReceived: boolean
      latestInventoryReceivedFrame: number
      pendingMissingWorktrees: Set<string>
    }
    type VisibilityResumeMissing = {
      environmentId: string
      inventoryReceivedFrame: number
      trackedWorktree: TrackedWebSessionTabsWorktree
      snapshot: RuntimeMobileSessionTabsRemovedResult
    }
    type VisibilityResumeBatch = {
      visibilityGeneration: number
      environments: Map<string, VisibilityResumeEnvironment>
      pendingInventoryCount: number
      pendingMissingByWorktree: Map<string, Map<string, VisibilityResumeMissing>>
      deferredRepairWorktrees: Set<string>
      trackedWorktreeIds: ReadonlySet<string>
      reapplyableSnapshotsByKey: Map<
        string,
        { snapshot: RuntimeMobileSessionTabsResult; receivedFrame: number }
      >
    }

    const subscriptionSpecs: WindowVisibilitySubscriptionSpec[] = []
    const environmentIdBySubscriptionSpec: string[] = []
    let visibilityResumeBatch: VisibilityResumeBatch | null = null
    const visibilityResumeOmissionsByKey = visibilityResumeOmissionsByKeyRef.current

    const recordVisibilityResumeSnapshotReceipt = (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number
    ): void => {
      const omission = visibilityResumeOmissionsByKey.get(
        sessionTabsFreshnessKey(environmentId, snapshot.worktree)
      )
      if (
        omission &&
        receivedFrame > omission.inventoryReceivedFrame &&
        ((snapshot as { removed?: unknown }).removed === true ||
          advancesSessionTabsFreshness(snapshot, omission.baseline))
      ) {
        omission.superseded = true
        if (visibilityResumeBatch?.pendingMissingByWorktree.has(snapshot.worktree)) {
          reconcileVisibilityResumeWorktrees([snapshot.worktree])
        }
      }
    }

    const shouldApplyVisibilityResumeSnapshot = (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number
    ): boolean => {
      const omission = visibilityResumeOmissionsByKey.get(
        sessionTabsFreshnessKey(environmentId, snapshot.worktree)
      )
      if (!omission) {
        return true
      }
      if (receivedFrame < omission.inventoryReceivedFrame) {
        return false
      }
      return (
        (snapshot as { removed?: unknown }).removed === true ||
        advancesSessionTabsFreshness(snapshot, omission.baseline)
      )
    }
    recordVisibilityResumeSnapshotReceiptRef.current = recordVisibilityResumeSnapshotReceipt
    shouldApplyVisibilityResumeSnapshotRef.current = shouldApplyVisibilityResumeSnapshot

    const isVisibilityResumeMissingCurrent = (missing: VisibilityResumeMissing): boolean => {
      const omission = visibilityResumeOmissionsByKey.get(
        sessionTabsFreshnessKey(missing.environmentId, missing.snapshot.worktree)
      )
      return (
        omission?.inventoryReceivedFrame === missing.inventoryReceivedFrame && !omission.superseded
      )
    }

    const getVisibilityResumeSnapshot = (
      batch: VisibilityResumeBatch,
      environmentId: string,
      worktreeId: string
    ): RuntimeMobileSessionTabsResult | null => {
      const key = sessionTabsFreshnessKey(environmentId, worktreeId)
      const entry = batch.reapplyableSnapshotsByKey.get(key)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      if (
        !entry ||
        freshness?.publicationEpoch !== entry.snapshot.publicationEpoch ||
        freshness.snapshotVersion !== entry.snapshot.snapshotVersion ||
        !shouldApplyRecoveredWebSessionTabsSnapshot(
          environmentId,
          entry.snapshot,
          entry.receivedFrame
        )
      ) {
        return null
      }
      return entry.snapshot
    }

    const finishVisibilityResumeBatchIfIdle = (batch: VisibilityResumeBatch): void => {
      if (
        batch.pendingInventoryCount === 0 &&
        batch.pendingMissingByWorktree.size === 0 &&
        visibilityResumeBatch === batch
      ) {
        visibilityResumeBatch = null
      }
    }

    // Why: omission tombstones touch shared terminal ids, so apply them only before replaying every surviving host.
    function reconcileVisibilityResumeWorktrees(worktreeIds: Iterable<string>): void {
      const batch = visibilityResumeBatch
      if (!batch) {
        return
      }
      const operations: WebSessionTabsSnapshotOperation[] = []
      for (const worktreeId of new Set(worktreeIds)) {
        const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
        if (!pendingMissing) {
          batch.deferredRepairWorktrees.delete(worktreeId)
          continue
        }
        for (const [environmentId, missing] of pendingMissing) {
          if (isVisibilityResumeMissingCurrent(missing)) {
            continue
          }
          pendingMissing.delete(environmentId)
          batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
        }
        if (pendingMissing.size === 0) {
          batch.pendingMissingByWorktree.delete(worktreeId)
          batch.deferredRepairWorktrees.delete(worktreeId)
          continue
        }
        const missingEnvironmentIds = new Set(pendingMissing.keys())
        const survivingSnapshots: {
          environmentId: string
          snapshot: RuntimeMobileSessionTabsResult
        }[] = []
        let canRepairSharedState = true
        for (const environmentId of sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? []) {
          if (missingEnvironmentIds.has(environmentId)) {
            continue
          }
          const snapshot = getVisibilityResumeSnapshot(batch, environmentId, worktreeId)
          if (!snapshot) {
            canRepairSharedState = false
            break
          }
          survivingSnapshots.push({ environmentId, snapshot })
        }
        if (!canRepairSharedState) {
          batch.deferredRepairWorktrees.add(worktreeId)
          continue
        }
        for (const missing of pendingMissing.values()) {
          operations.push({ environmentId: missing.environmentId, snapshot: missing.snapshot })
        }
        for (const { environmentId, snapshot } of survivingSnapshots) {
          acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
          operations.push({ environmentId, snapshot })
        }
        for (const environmentId of pendingMissing.keys()) {
          batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
        }
        batch.pendingMissingByWorktree.delete(worktreeId)
        batch.deferredRepairWorktrees.delete(worktreeId)
      }
      if (operations.length > 0) {
        const decided = decideWebSessionTabsSnapshotOperations(operations)
        const settleMirror = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshotOperations(state, decided),
          {
            frames: decided.map(({ environmentId, snapshot, decision }) => ({
              environmentId,
              worktreeId: snapshot.worktree,
              decision
            }))
          },
          operations.map(({ snapshot }) => snapshot)
        )
        // Why: every operation is post-recovery or inventory-absence evidence
        // with no finishRecovery of its own pending, so settle now — a deferred
        // tombstone otherwise leaves its worktree parked on a healthy host.
        settleMirror()
      }
      finishVisibilityResumeBatchIfIdle(batch)
    }

    const recordVisibilityResumeSnapshot = (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number
    ): void => {
      const batch = visibilityResumeBatch
      if (!batch || !batch.trackedWorktreeIds.has(snapshot.worktree)) {
        return
      }
      const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
      const existingIsCurrent = getVisibilityResumeSnapshot(batch, environmentId, snapshot.worktree)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      const repairsCrossHostCollision =
        (sessionTabsEnvironmentsByWorktree.get(snapshot.worktree)?.size ?? 0) > 1 ||
        batch.deferredRepairWorktrees.has(snapshot.worktree)
      if (
        (snapshot as { removed?: unknown }).removed === true ||
        snapshot.tabs.length === 0 ||
        !repairsCrossHostCollision ||
        freshness?.publicationEpoch !== snapshot.publicationEpoch ||
        freshness.snapshotVersion !== snapshot.snapshotVersion ||
        !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, snapshot, receivedFrame)
      ) {
        if (!existingIsCurrent) {
          batch.reapplyableSnapshotsByKey.delete(key)
        }
      } else {
        batch.reapplyableSnapshotsByKey.set(key, { snapshot, receivedFrame })
      }
      if (batch.pendingMissingByWorktree.has(snapshot.worktree)) {
        reconcileVisibilityResumeWorktrees([snapshot.worktree])
      }
    }

    const recordVisibilityResumeInventory = (
      environmentId: string,
      visibilityGeneration: number,
      inventoryReceivedFrame: number,
      missingWorktrees: readonly VisibilityResumeMissing[]
    ): void => {
      if (
        visibilityGeneration === 0 ||
        visibilityResumeBatch?.visibilityGeneration !== visibilityGeneration
      ) {
        return
      }
      const environment = visibilityResumeBatch.environments.get(environmentId)
      if (!environment || environment.latestInventoryReceivedFrame !== inventoryReceivedFrame) {
        return
      }
      const batch = visibilityResumeBatch
      const affectedWorktrees = new Set(environment.pendingMissingWorktrees)
      for (const worktreeId of environment.pendingMissingWorktrees) {
        const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
        pendingMissing?.delete(environmentId)
        if (pendingMissing?.size === 0) {
          batch.pendingMissingByWorktree.delete(worktreeId)
        }
      }
      environment.pendingMissingWorktrees.clear()
      for (const missing of missingWorktrees) {
        const worktreeId = missing.snapshot.worktree
        const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId) ?? new Map()
        pendingMissing.set(environmentId, missing)
        batch.pendingMissingByWorktree.set(worktreeId, pendingMissing)
        environment.pendingMissingWorktrees.add(worktreeId)
        affectedWorktrees.add(worktreeId)
      }
      if (!environment.inventoryReceived) {
        environment.inventoryReceived = true
        batch.pendingInventoryCount -= 1
      }
      reconcileVisibilityResumeWorktrees(affectedWorktrees)
    }
    recordVisibilityResumeSnapshotRef.current = recordVisibilityResumeSnapshot

    const recordVisibilityResumeInventoryReceipt = (
      environmentId: string,
      visibilityGeneration: number,
      inventoryReceivedFrame: number,
      snapshots: readonly RuntimeMobileSessionTabsResult[]
    ): VisibilityResumeMissing[] => {
      for (const snapshot of snapshots) {
        visibilityResumeOmissionsByKey.delete(
          sessionTabsFreshnessKey(environmentId, snapshot.worktree)
        )
      }
      if (visibilityResumeBatch?.visibilityGeneration !== visibilityGeneration) {
        return []
      }
      const environment = visibilityResumeBatch.environments.get(environmentId)
      if (!environment) {
        return []
      }
      environment.latestInventoryReceivedFrame = Math.max(
        environment.latestInventoryReceivedFrame,
        inventoryReceivedFrame
      )
      if (environment.latestInventoryReceivedFrame !== inventoryReceivedFrame) {
        return []
      }
      const publishedWorktrees = new Set(snapshots.map((snapshot) => snapshot.worktree))
      return buildMissingWebSessionTabsRemovals(
        environmentId,
        environment.trackedWorktrees,
        publishedWorktrees
      ).map((missing) => {
        const key = sessionTabsFreshnessKey(environmentId, missing.snapshot.worktree)
        visibilityResumeOmissionsByKey.set(key, {
          baseline: missing.trackedWorktree.freshness,
          environmentId,
          inventoryReceivedFrame,
          superseded: false,
          visibilityGeneration
        })
        recordReceivedWebSessionTabsRemoval(
          environmentId,
          missing.snapshot.worktree,
          inventoryReceivedFrame
        )
        return { environmentId, inventoryReceivedFrame, ...missing }
      })
    }

    const beginVisibilityResume = ({
      visibilityGeneration,
      restartingSpecIndexes
    }: {
      visibilityGeneration: number
      restartingSpecIndexes: readonly number[]
    }): void => {
      const activeRuntimeWorktreeKey = activeRuntimeWorktreeKeyRef.current
      for (const [key, omission] of visibilityResumeOmissionsByKey) {
        // Why: the active worktree's scoped stream resumes before its host inventory, so its fence outlives exactly one resume - never more.
        if (
          key !== activeRuntimeWorktreeKey ||
          omission.visibilityGeneration < visibilityGeneration - 1
        ) {
          visibilityResumeOmissionsByKey.delete(key)
        }
      }
      const resumedEnvironments = new Map<string, VisibilityResumeEnvironment>()
      const trackedWorktreeIds = new Set<string>()
      for (const index of restartingSpecIndexes) {
        const environmentId = environmentIdBySubscriptionSpec[index]
        if (environmentId) {
          const trackedWorktrees = getTrackedWebSessionTabsWorktrees(environmentId)
          if (trackedWorktrees.length === 0) {
            continue
          }
          for (const { worktree } of trackedWorktrees) {
            trackedWorktreeIds.add(worktree)
          }
          resumedEnvironments.set(environmentId, {
            trackedWorktrees,
            inventoryReceived: false,
            latestInventoryReceivedFrame: 0,
            pendingMissingWorktrees: new Set()
          })
        }
      }
      visibilityResumeBatch =
        resumedEnvironments.size > 0
          ? {
              visibilityGeneration,
              environments: resumedEnvironments,
              pendingInventoryCount: resumedEnvironments.size,
              pendingMissingByWorktree: new Map(),
              deferredRepairWorktrees: new Set(),
              trackedWorktreeIds,
              reapplyableSnapshotsByKey: new Map()
            }
          : null
    }

    // Why: the stream's initial snapshot can land after first render, so a one-shot fetch makes initial parity deterministic.
    for (const { environmentId, expectedEnvironmentPairingRevision } of environments) {
      if (
        !shouldSyncAllRuntimeSessionTabs({
          activeRuntimeEnvironmentId: environmentId,
          workspaceSessionReady
        })
      ) {
        continue
      }
      let requestedInitialLoad = false
      environmentIdBySubscriptionSpec.push(environmentId)
      subscriptionSpecs.push({
        subscribe: (isCurrent, { visibilityGeneration }) => {
          const isVisibilityRestart = visibilityGeneration > 0
          let awaitingVisibilityResumeInventory = isVisibilityRestart
          if (!requestedInitialLoad) {
            requestedInitialLoad = true
            loadInitialWebSessionTabs(environmentId, expectedEnvironmentPairingRevision, isCurrent)
          }
          return window.api.runtimeEnvironments.subscribe(
            {
              selector: environmentId,
              method: 'session.tabs.subscribeAll',
              params: {},
              timeoutMs: 15_000,
              expectedEnvironmentPairingRevision
            },
            {
              onResponse: (response: RuntimeRpcResponse<unknown>) => {
                if (
                  !isCurrent() ||
                  getRuntimeEnvironmentRevision(environmentId) !==
                    expectedEnvironmentPairingRevision
                ) {
                  return
                }
                if (response.ok === false) {
                  console.warn(
                    '[web-session-tabs-sync] global subscription failed:',
                    response.error.message
                  )
                  return
                }
                const event = response.result as SessionTabsStreamEvent
                const replayed = isRuntimeSubscriptionReplayResponse(response)
                if (event.type === 'snapshots') {
                  const skipUnchangedResumeWork = awaitingVisibilityResumeInventory && !replayed
                  awaitingVisibilityResumeInventory = false
                  // Why: an unchanged epoch/version proves the host published nothing while parked, so there is no missed frame to recover or replay.
                  const unchangedVisibilityResumeSnapshots = event.snapshots.map((snapshot) => {
                    const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
                    const freshness = latestSessionTabsSnapshotByWorktree.get(key)
                    return Boolean(
                      skipUnchangedResumeWork &&
                      // Why: an armed replay is an outstanding repair request, so that worktree must be rebuilt even when the host looks unchanged.
                      !replayableSessionTabsSnapshotByWorktree.has(key) &&
                      freshness?.publicationEpoch === snapshot.publicationEpoch &&
                      freshness.snapshotVersion === snapshot.snapshotVersion
                    )
                  })
                  const receivedFrames = event.snapshots.map((snapshot) => {
                    const receivedFrame = recordReceivedWebSessionTabsSnapshot(
                      environmentId,
                      snapshot
                    )
                    recordVisibilityResumeSnapshotReceipt(environmentId, snapshot, receivedFrame)
                    return receivedFrame
                  })
                  const inventoryReceivedFrame = recordReceivedWebSessionTabsInventory()
                  const missingWorktrees = recordVisibilityResumeInventoryReceipt(
                    environmentId,
                    visibilityGeneration,
                    inventoryReceivedFrame,
                    event.snapshots
                  )
                  const finishRecoveries = event.snapshots.map((snapshot, index) =>
                    unchangedVisibilityResumeSnapshots[index]
                      ? null
                      : beginWebSessionTabsSnapshotRecovery(
                          environmentId,
                          snapshot.worktree,
                          receivedFrames[index]!
                        )
                  )
                  let settleHydration: (() => void) | null = null
                  void Promise.all(
                    event.snapshots.map((snapshot, index) =>
                      unchangedVisibilityResumeSnapshots[index]
                        ? Promise.resolve(snapshot)
                        : recoverWebSessionTerminalOrphansBeforeApply(
                            useAppStore.getState(),
                            snapshot,
                            environmentId
                          )
                    )
                  )
                    .then((recovered) => {
                      if (isCurrent()) {
                        const applicable = recovered.flatMap((snapshot, index) =>
                          snapshot !== null &&
                          shouldApplyRecoveredWebSessionTabsSnapshot(
                            environmentId,
                            snapshot,
                            receivedFrames[index]!
                          ) &&
                          shouldApplyVisibilityResumeSnapshot(
                            environmentId,
                            snapshot,
                            receivedFrames[index]!
                          )
                            ? [{ index, snapshot }]
                            : []
                        )
                        if (isVisibilityRestart || replayed) {
                          for (const { index, snapshot } of applicable) {
                            if (unchangedVisibilityResumeSnapshots[index]) {
                              continue
                            }
                            acceptReplayedWebSessionTabsSnapshot(environmentId, snapshot.worktree)
                          }
                        }
                        // Why: an unchanged resume snapshot is never re-decided
                        // — the store already holds the view it would rewrite.
                        const decisions = applicable.map(({ index, snapshot }) =>
                          unchangedVisibilityResumeSnapshots[index]
                            ? WEB_SESSION_TABS_FRAME_OUTRANKED
                            : decideWebSessionTabsSnapshot(snapshot, environmentId)
                        )
                        const freshSnapshots = applicable.flatMap(({ snapshot }, position) =>
                          decisions[position]!.apply ? [snapshot] : []
                        )
                        settleHydration = applyWebSessionTabsStorePatch(
                          (state) =>
                            applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId),
                          {
                            frames: applicable.map(({ snapshot }, position) => ({
                              environmentId,
                              worktreeId: snapshot.worktree,
                              decision: decisions[position]!
                            })),
                            fullInventory: {
                              environmentId,
                              // Why: a workspace the mirror never writes is not
                              // part of the inventory this verdict accounts for.
                              publishedSnapshotCount: event.snapshots.filter((snapshot) =>
                                isHostMirroredWorktree(snapshot.worktree)
                              ).length
                            }
                          },
                          freshSnapshots
                        )
                        const freshSnapshotSet = new Set(freshSnapshots)
                        for (const { index, snapshot } of applicable) {
                          if (unchangedVisibilityResumeSnapshots[index]) {
                            queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
                          }
                          if (
                            unchangedVisibilityResumeSnapshots[index] ||
                            freshSnapshotSet.has(snapshot)
                          ) {
                            recordVisibilityResumeSnapshot(
                              environmentId,
                              snapshot,
                              receivedFrames[index]!
                            )
                          }
                        }
                        recordVisibilityResumeInventory(
                          environmentId,
                          visibilityGeneration,
                          inventoryReceivedFrame,
                          missingWorktrees
                        )
                      }
                    })
                    .catch((error) => {
                      if (isCurrent()) {
                        console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
                      }
                    })
                    .finally(() => {
                      for (const finishRecovery of finishRecoveries) {
                        finishRecovery?.()
                      }
                      // Why: an inventory speaks only once its patch is in the
                      // store — settling earlier, or on snapshots recovery
                      // discarded, drains parked work against state nobody wrote.
                      if (isCurrent()) {
                        settleHydration?.()
                      }
                    })
                  return
                }
                if (event.type !== 'snapshot' && event.type !== 'updated') {
                  // Why: silence carries no frame, and a stream that stopped
                  // talking has not reported a single PTY dead.
                  return
                }
                const receivedFrame = recordReceivedWebSessionTabsSnapshot(environmentId, event)
                recordVisibilityResumeSnapshotReceipt(environmentId, event, receivedFrame)
                const finishRecovery = beginWebSessionTabsSnapshotRecovery(
                  environmentId,
                  event.worktree,
                  receivedFrame
                )
                let settleHydration: HostSessionMirrorSettle | null = null
                void recoverWebSessionTerminalOrphansBeforeApply(
                  useAppStore.getState(),
                  event,
                  environmentId
                )
                  .then((recovered) => {
                    if (
                      isCurrent() &&
                      recovered &&
                      shouldApplyRecoveredWebSessionTabsSnapshot(
                        environmentId,
                        recovered,
                        receivedFrame
                      ) &&
                      shouldApplyVisibilityResumeSnapshot(environmentId, recovered, receivedFrame)
                    ) {
                      if (replayed) {
                        acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
                      }
                      const decision = decideWebSessionTabsSnapshot(recovered, environmentId)
                      if (decision.apply) {
                        settleHydration = applyWebSessionTabsStorePatch(
                          (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
                          {
                            frames: [{ environmentId, worktreeId: recovered.worktree, decision }]
                          },
                          recovered,
                          event.type === 'updated' && !replayed
                        )
                        recordVisibilityResumeSnapshot(environmentId, recovered, receivedFrame)
                      } else {
                        settleHydration = hostSessionMirrorSettleForPatchlessFrame(
                          decision,
                          environmentId,
                          recovered.worktree
                        )
                      }
                    }
                  })
                  .catch((error) => {
                    if (isCurrent()) {
                      console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
                    }
                  })
                  .finally(() => {
                    finishRecovery()
                    // Why: this frame speaks for its own worktree only, and only
                    // through the receipt of what actually landed — a discarded
                    // frame leaves the pane's PTY as unaccounted as before.
                    if (isCurrent()) {
                      settleHydration?.()
                    }
                  })
              },
              onError: (error) => {
                if (isCurrent()) {
                  console.warn('[web-session-tabs-sync] global subscription error:', error.message)
                }
              }
            }
          )
        },
        onSubscribeError: (error) => {
          console.warn(
            '[web-session-tabs-sync] failed to subscribe globally:',
            error instanceof Error ? error.message : String(error)
          )
        },
        onUnsubscribeError: (error) => {
          console.warn('[web-session-tabs-sync] failed to unsubscribe globally:', error)
        }
      })
    }
    // Why: pace full-host inventories while the scoped active-worktree mirror resumes immediately.
    const disposeSubscriptions = installWindowVisibilitySubscriptionParking(subscriptionSpecs, {
      getVisibilityResumePriority: (index) =>
        environmentIdBySubscriptionSpec[index] === activeRuntimeEnvironmentIdRef.current ? 0 : 1,
      visibilityResumeStaggerMs: WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS,
      onVisibilityResume: beginVisibilityResume
    })

    return () => {
      recordVisibilityResumeSnapshotRef.current = () => {}
      recordVisibilityResumeSnapshotReceiptRef.current = () => {}
      shouldApplyVisibilityResumeSnapshotRef.current = () => true
      disposeSubscriptions()
      for (const { environmentId, expectedEnvironmentPairingRevision } of environments) {
        const owner = {
          environmentId,
          pairingRevision: expectedEnvironmentPairingRevision
        }
        clearWebSessionCloseIntentsForOwner(owner)
        clearWebSessionFocusIntentsForOwner(owner)
        clearWebSessionReorderIntentsForOwner(owner)
      }
    }
  }, [runtimeSessionMirrorEnvironmentKey, workspaceSessionReady])

  useEffect(() => {
    const environmentId = activeWorktreeRuntimeEnvironmentId?.trim()
    const expectedEnvironmentPairingRevision = activeWorktreeRuntimePairingRevision
    if (
      !shouldSyncRuntimeSessionTabs({
        activeWorktreeId,
        activeWorktreeRuntimeEnvironmentId,
        workspaceSessionReady
      }) ||
      !environmentId ||
      !activeWorktreeId
    ) {
      return
    }

    let requestedInitialTerminal = false
    let requestedRespawnAfterWake = false
    /** Resolves the settle receipt of the evidence this frame put (or already
     *  had) in the store, or null when the frame was discarded undecided. */
    const applyActiveSnapshot = async (
      event: RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' },
      response: RuntimeRpcResponse<unknown>,
      isCurrent: () => boolean,
      receivedFrame: number
    ): Promise<HostSessionMirrorSettle | null> => {
      const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
        useAppStore.getState(),
        event,
        environmentId
      )
      if (
        !isCurrent() ||
        !recovered ||
        !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, recovered, receivedFrame) ||
        !shouldApplyVisibilityResumeSnapshotRef.current(environmentId, recovered, receivedFrame)
      ) {
        return null
      }
      if (event.type === 'snapshot' || isRuntimeSubscriptionReplayResponse(response)) {
        // Why: the parallel global stream can consume an earlier replay allowance before this authoritative snapshot lands.
        acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
      }
      const recoveredEvent: SessionTabsStreamEvent = { ...recovered, type: event.type }
      const decision = decideWebSessionTabsSnapshot(recovered, environmentId)
      const fresh = decision.apply
      const syncState = useAppStore.getState()
      const localWorktreeTabs = syncState.tabsByWorktree[activeWorktreeId] ?? []
      const localTerminalCount = localWorktreeTabs.length
      const hasLiveLocalPty = localWorktreeTabs.some(
        (tab) => (syncState.ptyIdsByTabId[tab.id] ?? []).length > 0
      )
      const shouldBootstrapInitialTerminal = shouldBootstrapInitialWebRuntimeTerminal({
        event: recoveredEvent,
        activeWorktreeId,
        requestedInitialTerminal,
        snapshotIsFresh: fresh,
        localTerminalCount
      })
      const shouldRespawnAfterWake = shouldRespawnWebRuntimeTerminalAfterWake({
        event: recoveredEvent,
        activeWorktreeId,
        requestedRespawnAfterWake,
        snapshotIsFresh: fresh,
        localTerminalCount,
        hasLiveLocalPty,
        skipWakeRespawn: shouldSkipWebRuntimeWakeTerminalRespawn(activeWorktreeId)
      })
      // Why: a rejected frame settles only on the accepted view that outranked it.
      let settleMirror: HostSessionMirrorSettle | null = fresh
        ? null
        : hostSessionMirrorSettleForPatchlessFrame(decision, environmentId, recovered.worktree)
      try {
        if (fresh) {
          const replayed = isRuntimeSubscriptionReplayResponse(response)
          settleMirror = applyWebSessionTabsStorePatch(
            (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
            { frames: [{ environmentId, worktreeId: recovered.worktree, decision }] },
            recovered,
            event.type === 'updated' && !replayed
          )
          recordVisibilityResumeSnapshotRef.current(environmentId, recovered, receivedFrame)
        }
        if (isCurrent() && shouldBootstrapInitialTerminal) {
          requestedInitialTerminal = true
          await createWebRuntimeSessionTerminal({
            worktreeId: activeWorktreeId,
            environmentId,
            activate: true
          })
        } else if (
          isCurrent() &&
          shouldRespawnAfterWake &&
          beginWebRuntimeWakeTerminalRespawn(activeWorktreeId)
        ) {
          requestedRespawnAfterWake = true
          await createWebRuntimeSessionTerminal({
            worktreeId: activeWorktreeId,
            environmentId,
            activate: true,
            selectWorktree: false
          }).finally(() => endWebRuntimeWakeTerminalRespawn(activeWorktreeId))
        }
      } catch (error) {
        // Why: the spawn is a side effect of the frame, not part of it — failing
        // after the patch landed cannot un-land it, and the host is still healthy.
        if (isCurrent()) {
          console.warn('[web-session-tabs-sync] snapshot follow-up failed:', error)
        }
      }
      return settleMirror
    }
    const disposeSubscription = installWindowVisibilitySubscriptionParking([
      {
        subscribe: (isCurrent) =>
          window.api.runtimeEnvironments.subscribe(
            {
              selector: environmentId,
              method: 'session.tabs.subscribe',
              params: { worktree: toRuntimeWorktreeSelector(activeWorktreeId) },
              timeoutMs: 15_000,
              expectedEnvironmentPairingRevision
            },
            {
              onResponse: (response: RuntimeRpcResponse<unknown>) => {
                if (
                  !isCurrent() ||
                  getRuntimeEnvironmentRevision(environmentId) !==
                    expectedEnvironmentPairingRevision
                ) {
                  return
                }
                if (response.ok === false) {
                  console.warn(
                    '[web-session-tabs-sync] subscription failed:',
                    response.error.message
                  )
                  return
                }
                const event = response.result as SessionTabsStreamEvent
                if (event.type !== 'snapshot' && event.type !== 'updated') {
                  // No frame to apply, and a dead stream is not a verdict about
                  // this worktree — let alone about the whole environment.
                  return
                }
                const receivedFrame = recordReceivedWebSessionTabsSnapshot(environmentId, event)
                recordVisibilityResumeSnapshotReceiptRef.current(
                  environmentId,
                  event,
                  receivedFrame
                )
                const finishRecovery = beginWebSessionTabsSnapshotRecovery(
                  environmentId,
                  event.worktree,
                  receivedFrame
                )
                void applyActiveSnapshot(event, response, isCurrent, receivedFrame)
                  .catch((error) => {
                    if (isCurrent()) {
                      console.warn(
                        '[web-session-tabs-sync] active snapshot recovery failed:',
                        error
                      )
                    }
                    return null
                  })
                  .then((settleMirror) => {
                    finishRecovery()
                    // Why: the active-worktree mirror is authoritative for this
                    // worktree alone, and only through its landed receipt.
                    if (isCurrent()) {
                      settleMirror?.()
                    }
                  })
              },
              onError: (error) => {
                if (isCurrent()) {
                  console.warn('[web-session-tabs-sync] subscription error:', error.message)
                }
              }
            }
          ),
        onSubscribeError: (error) => {
          console.warn(
            '[web-session-tabs-sync] failed to subscribe:',
            error instanceof Error ? error.message : String(error)
          )
        },
        onUnsubscribeError: (error) => {
          console.warn('[web-session-tabs-sync] failed to unsubscribe:', error)
        }
      }
    ])

    return disposeSubscription
  }, [
    activeWorktreeId,
    activeWorktreeRuntimeEnvironmentId,
    activeWorktreeRuntimeConnectionGeneration,
    activeWorktreeRuntimeId,
    activeWorktreeRuntimePairingRevision,
    workspaceSessionReady
  ])
}
