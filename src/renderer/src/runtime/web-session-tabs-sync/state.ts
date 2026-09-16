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

/**
 * Runtime ids identify a host process, unlike publication epochs which may be
 * minted by several publishers. Retain a bounded predecessor set so a frame
 * queued by a restarted host cannot be mistaken for a fresh publication.
 */
export type RetiredValueHistory = {
  current: string | null
  retired: string[]
}

export type SessionTabsRuntimeHistory = RetiredValueHistory

/**
 * A host restart changes the publication epoch, but frames from the previous
 * epoch can still be queued on a sibling subscription. Keep a small history
 * of epochs that have already been superseded so those delayed frames cannot
 * roll the mirror back after the replacement epoch is accepted.
 */
export type SessionTabsPublicationEpochHistory = RetiredValueHistory
export type SessionTabsRecoveryState = { pendingCount: number }
export type SessionTabsRemovalFence = {
  receivedFrame: number
  recoveryState: SessionTabsRecoveryState
  pendingCount: number
}

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
export const latestReceivedSessionTabsSnapshotByWorktree = new Map<
  string,
  ReceivedSessionTabsSnapshot
>()
export const sessionTabsRuntimeHistoryByEnvironment = new Map<string, SessionTabsRuntimeHistory>()
export const sessionTabsPublicationEpochHistoryByWorktree = new Map<
  string,
  SessionTabsPublicationEpochHistory
>()
export const latestReceivedSessionTabsFrameByEnvironment = new Map<string, number>()
export const latestReceivedSessionTabsInventoryFrameByEnvironment = new Map<string, number>()
export const latestSessionTabsRemovalFenceByWorktree = new Map<string, SessionTabsRemovalFence>()
export const sessionTabsRecoveryStateByWorktree = new Map<string, SessionTabsRecoveryState>()
export const trackedSessionTabsWorktreeIdsByEnvironment = new Map<string, Set<string>>()
export const sessionTabsEnvironmentsByWorktree = new Map<string, Set<string>>()
export const sessionTabsTrackingGenerationByEnvironment = new Map<string, number>()
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
  agentPaneKeysByTabId: Map<string, Set<string>> | null
  changedRecords: Set<WebSessionTabsBatchRecordKey>
  openFilesIndex: WebSessionOpenFilesIndex | null
}

export type AgentTab = RuntimeMobileSessionAgentTab
export type TabGroupSnapshot = RuntimeMobileSessionTabGroup
export type RemovedTabsResult = RuntimeMobileSessionTabsRemovedResult
