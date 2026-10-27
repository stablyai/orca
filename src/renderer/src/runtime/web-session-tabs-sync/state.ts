import type { AppState } from '../../store'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import type {
  BrowserCertificateFailure,
  BrowserPage,
  BrowserWorkspace
} from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { OpenFile } from '../../store/slices/editor'
import type { RuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'

export const WEB_SESSION_GROUP_PREFIX = 'web-session-tabs:'
export const WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS = 100
export const VISIBILITY_INVENTORY_REMOVAL_EPOCH = 'visibility-inventory-removal'
export const HOST_WORKING_CLIENT_BOUNDARY_LIMIT = 512

export type SessionTabsStreamEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: boolean }
  | { type: 'end' }

export function isSessionTabsStreamEnd(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'type' in result && result.type === 'end'
}

export type SessionTabsListAllResult = {
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative?: boolean
}

export type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

export type ReceivedSessionTabsSnapshot = SnapshotFreshness & {
  receivedFrame: number
  runtimeId?: string
}

/** Runtime IDs name host processes; retain bounded retired predecessors so queued old-process frames cannot look like fresh publishers. */
export type RetiredValueHistory = {
  current: string | null
  retired: string[]
}

export type SessionTabsRuntimeHistory = RetiredValueHistory

/** Bounded retired-epoch history prevents sibling streams’ delayed frames rolling back accepted replacements after restart. */
export type SessionTabsPublicationEpochHistory = RetiredValueHistory

export type WebSessionTabsSnapshotApplyOptions = {
  contentScope?: 'all' | 'agent-session'
  preserveLocalLayout?: boolean
  terminalPtyMode?: 'local' | 'remote'
}

export type TrackedWebSessionTabsWorktree = {
  worktree: string
  freshness: SnapshotFreshness
}

export type VisibilityResumeOmission = {
  baseline: SnapshotFreshness
  environmentId: string
  inventoryReceivedFrame: number
  superseded: boolean
  visibilityGeneration: number
}

export const latestSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()
export const replayableSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()

export function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

// Allow replay of current epoch/version exactly once; older concurrent frames must retain ordering checks.
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
export const latestReceivedSessionTabsSnapshotByWorktree = new Map<
  string,
  ReceivedSessionTabsSnapshot
>()
/** Receipt ledgers outlive the worktrees they order, so their keys need a bound of their own. */
export const MAX_TRACKED_SESSION_TABS_RECEIPTS = 512

/** Bound receipts by frame age, not insertion count: one inventory shares a frame across worktrees and must not evict its own evidence. Drop only entries no in-flight frame can rank against. */
export function setBoundedSessionTabsReceipt<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  frameOf: (entry: T) => number
): void {
  map.set(key, value)
  if (map.size <= MAX_TRACKED_SESSION_TABS_RECEIPTS) {
    return
  }
  const oldestRankableFrame = receivedSessionTabsFrameSequence - MAX_TRACKED_SESSION_TABS_RECEIPTS
  for (const [entryKey, entry] of map) {
    if (frameOf(entry) < oldestRankableFrame) {
      map.delete(entryKey)
    }
  }
}

export const sessionTabsRuntimeHistoryByEnvironment = new Map<string, SessionTabsRuntimeHistory>()
export const sessionTabsPublicationEpochHistoryByWorktree = new Map<
  string,
  SessionTabsPublicationEpochHistory
>()
export const latestReceivedSessionTabsFrameByEnvironment = new Map<string, number>()
export const latestReceivedSessionTabsInventoryFrameByEnvironment = new Map<string, number>()
/** Raise-only retraction watermark fences all pre-close reserved frames even after later publications overwrite receipts. Never size-evict boundaries or stale lists reenter; one number per retracted worktree persists until environment teardown. */
export const sessionTabsRemovalWatermarkByWorktree = new Map<string, number>()
export const trackedSessionTabsWorktreeIdsByEnvironment = new Map<string, Set<string>>()
export const sessionTabsEnvironmentsByWorktree = new Map<string, Set<string>>()
export const lastHostTerminalTabCountByWorktree = new Map<string, number>()
export const MAX_TRACKED_SESSION_TABS_INVENTORY_OMISSIONS = 512
export type SessionTabsInventoryOmissionObservation = {
  fingerprint: string
  observations: number
}
export const sessionTabsInventoryOmissionsByWorktree = new Map<
  string,
  SessionTabsInventoryOmissionObservation
>()
export const hostSessionTabIdByLocalKey = new Map<string, string>()
// Why: desktop and host mint their own ids for a group a split creates; moves name the host's.
export const hostSessionGroupIdByLocalKey = new Map<string, string>()
export const hostSessionTabMappingKeysByEnvironmentAndWorktree = new Map<
  string,
  Map<string, Set<string>>
>()
export const hostWorkingClientBoundaryByPaneKey = new Map<
  string,
  {
    hostStateStartedAt: number
    hostPrompt: string
    clientStateStartedAt: number
    stamped: boolean
  }
>()

export let receivedSessionTabsFrameSequence = 0
export function nextReceivedSessionTabsFrame(): number {
  receivedSessionTabsFrameSequence += 1
  return receivedSessionTabsFrameSequence
}
export function resetReceivedSessionTabsFrameSequence(): void {
  receivedSessionTabsFrameSequence = 0
}

export type TerminalSurface = RuntimeMobileSessionTerminalClientTab
export type ReadyTerminalSurface = RuntimeMobileSessionTerminalClientTab & { status: 'ready' }
export type ReadyBrowserSurface = RuntimeMobileSessionBrowserTab & { browserPageId: string }
export type ReadyEditorSurface = RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab

export type MirroredAgentTab = { hostTabId: string; unifiedTab: Tab }
export type MirroredTerminalTab = {
  tab: TerminalTab
  hostTabId: string
  ptyIds: string[]
  layout: TerminalLayoutSnapshot
  retainedSurfaceByPrunedLeafId?: ReadonlyMap<string, TerminalSurface>
}
export type MirroredBrowserTab = {
  workspace: BrowserWorkspace
  page: BrowserPage
  certificateFailure: BrowserCertificateFailure | null
  remotePageId: string
  browserProfileId?: string
  placement?: RuntimeBrowserPlacement
  unifiedTab: Tab
  hostTabId: string
  clientGroupId?: string
}
export type MirroredEditorTab = { file: OpenFile; unifiedTab: Tab; hostTabId: string }

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
  | 'editorBuffers'
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
      | 'activityClearedAtByPaneKey'
      | 'agentLaunchConfigByPaneKey'
      | 'automaticAgentResumeClaimsByTabId'
      // Client draft proves dirty-flag ownership (#21392); without one, follow host save state.
      | 'editorDrafts'
      // Why: the live index carries sticky detachments; absent here, views resolve by identity.
      | 'editorBufferIdOf'
      | 'localOnlyScrollbackByTabId'
      | 'migrationUnsupportedByPtyId'
      | 'manuallyUnreadTurnsByPaneKey'
      | 'paneForegroundAgentByPaneKey'
      | 'pendingStartupByTabId'
      | 'recentlyClosedAgentStatusTabIds'
      | 'recentlyRetiredAgentStatusPaneKeys'
      | 'retainedAgentsByPaneKey'
      | 'retentionSuppressedPaneKeys'
    >
  >

export type WebSessionTabsBatchRecordKey =
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
  | 'localOnlyScrollbackByTabId'
  | 'pendingStartupByTabId'
  | 'ptyIdsByTabId'
  | 'remoteBrowserPageHandlesByPageId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'

export type WebSessionOpenFilesIndex = {
  source: readonly OpenFile[]
  byWorktree: Map<string, OpenFile[]>
}
export type WebSessionTabsBatchContext = {
  retractionPaneKeysByRecord?: WeakMap<object, Map<string, Set<string>>>
  agentPaneKeysByTabId: Map<string, Set<string>> | null
  changedRecords: Set<WebSessionTabsBatchRecordKey>
  openFilesIndex: WebSessionOpenFilesIndex | null
}

export type AgentTab = RuntimeMobileSessionAgentTab
export type TabGroupSnapshot = RuntimeMobileSessionTabGroup
export type RemovedTabsResult = RuntimeMobileSessionTabsRemovedResult
