import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type {
  AgentActivityDisplayMode,
  ManualRepoOrderEntry,
  ProjectOrderBy,
  StatusBarItem,
  WorktreeCardMode,
  WorktreeCardProperty,
  WorkspaceHostOrder,
  WorkspaceHostScope,
  VisibleWorkspaceHostIds
} from '../../../../../shared/ui-chrome-types'
import type { UsagePercentageDisplay } from '../../../../../shared/usage-percentage-display'
import type { AutomationHostFilter } from '../../../../../shared/automation-host-filter'
import type { WorkspaceStatusDefinition } from '../../../../../shared/worktree/types'
import type { WorkspacePortScanResult } from '../../../../../shared/workspace-ports'
import type { CustomPet } from '../../../../../shared/pet-types'
import type { ReleaseChannel } from '../../../../../shared/release-channel'
import type { ChangelogData, UpdateStatus } from '../../../../../shared/update-status-types'
import type { StatusBarUsageMode } from '../../../../../shared/status-bar-usage-mode'
import type { PersistedUIWriteBaseline } from '../persisted-ui-write-baseline'
import type { UISliceCore } from './ui-slice-contract-core'

export type UISlicePreferences = {
  /** Which list the sidebar body shows. Navigator-only; does not change the active view. */
  sidebarBody: 'workspaces' | 'agents'
  setSidebarBody: (body: UISlicePreferences['sidebarBody']) => void
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  setGroupBy: (g: UISlicePreferences['groupBy']) => void
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  setSortBy: (s: UISlicePreferences['sortBy']) => void
  projectOrderBy: ProjectOrderBy
  setProjectOrderBy: (p: ProjectOrderBy) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  showSleepingWorkspaces: boolean
  setShowSleepingWorkspaces: (v: boolean) => void
  workspaceHostScope: WorkspaceHostScope
  setWorkspaceHostScope: (scope: WorkspaceHostScope) => void
  visibleWorkspaceHostIds: VisibleWorkspaceHostIds
  setVisibleWorkspaceHostIds: (ids: VisibleWorkspaceHostIds) => void
  workspaceHostOrder: WorkspaceHostOrder
  setWorkspaceHostOrder: (ids: WorkspaceHostOrder) => void
  /** Automations page host filter, in stable form. Never written from an unhydrated catalog. */
  automationHostFilter: AutomationHostFilter
  setAutomationHostFilter: (filter: AutomationHostFilter) => void
  manualRepoOrder: ManualRepoOrderEntry[]
  hideDefaultBranchWorkspace: boolean
  setHideDefaultBranchWorkspace: (v: boolean) => void
  hideAutomationGeneratedWorkspaces: boolean
  setHideAutomationGeneratedWorkspaces: (v: boolean) => void
  hideCliCreatedWorkspaces: boolean
  setHideCliCreatedWorkspaces: (v: boolean) => void
  hideDetachedHeadWorkspaces: boolean
  setHideDetachedHeadWorkspaces: (v: boolean) => void
  hideWorkspacesFromOtherDevices: boolean
  setHideWorkspacesFromOtherDevices: (v: boolean) => void
  alwaysShowDefaultBranchWorkspace: boolean
  setAlwaysShowDefaultBranchWorkspace: (v: boolean) => void
  showDotfilesByWorktree: Record<string, boolean>
  setShowDotfilesForWorktree: (worktreeId: string, showDotfiles: boolean) => void
  toggleShowDotfilesForWorktree: (worktreeId: string) => void
  filterRepoIds: readonly string[]
  setFilterRepoIds: (ids: readonly string[]) => void
  /** Agents-view scope filters, independent from workspace navigation filters. */
  agentsVisibleHostIds: VisibleWorkspaceHostIds
  setAgentsVisibleHostIds: (ids: VisibleWorkspaceHostIds) => void
  agentsFilterRepoIds: readonly string[]
  setAgentsFilterRepoIds: (ids: readonly string[]) => void
  agentsShowChildAgents: boolean
  setAgentsShowChildAgents: (v: boolean) => void
  agentsCompactMode: boolean
  setAgentsCompactMode: (v: boolean) => void
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
  worktreeCardProperties: WorktreeCardProperty[]
  _worktreeCardModeDefaulted: boolean
  setWorktreeCardMode: (mode: WorktreeCardMode) => void
  setWorktreeCardProperties: (properties: readonly WorktreeCardProperty[]) => void
  agentActivityDisplayMode: AgentActivityDisplayMode
  setAgentActivityDisplayMode: (mode: AgentActivityDisplayMode) => void
  workspaceStatuses: WorkspaceStatusDefinition[]
  setWorkspaceStatuses: (statuses: WorkspaceStatusDefinition[]) => void
  workspaceBoardOpacity: number
  setWorkspaceBoardOpacity: (opacity: number) => void
  workspaceBoardColumnWidth: number
  setWorkspaceBoardColumnWidth: (width: number) => void
  syncTaskStatusFromWorkspaceBoard: boolean
  setSyncTaskStatusFromWorkspaceBoard: (enabled: boolean) => void
  /** Transient: the in-window Agent Dashboard companion drawer is open. Not persisted. */
  agentDashboardDrawerOpen: boolean
  setAgentDashboardDrawerOpen: (open: boolean) => void
  statusBarItems: StatusBarItem[]
  toggleStatusBarItem: (item: StatusBarItem) => void
  statusBarVisible: boolean
  setStatusBarVisible: (v: boolean) => void
  usagePercentageDisplay: UsagePercentageDisplay
  setUsagePercentageDisplay: (display: UsagePercentageDisplay) => void
  statusBarUsageMode: StatusBarUsageMode
  setStatusBarUsageMode: (mode: StatusBarUsageMode) => void
}

export type UISliceSurfaces = {
  workspacePortScan: { key: string; result: WorkspacePortScanResult } | null
  workspacePortScansByKey: Record<string, WorkspacePortScanResult>
  workspacePortScanRefreshing: boolean
  setWorkspacePortScan: (scan: { key: string; result: WorkspacePortScanResult } | null) => void
  setWorkspacePortScanProjection: (
    scan: { key: string; result: WorkspacePortScanResult } | null
  ) => void
  replaceWorkspacePortScans: (
    scansByKey: Record<string, WorkspacePortScanResult>,
    projection: { key: string; result: WorkspacePortScanResult } | null
  ) => void
  setWorkspacePortScanForKey: (key: string, result: WorkspacePortScanResult | null) => void
  setWorkspacePortScanRefreshing: (refreshing: boolean) => void
  /** Whether the pet overlay is currently visible. Persisted so "Hide pet" survives reload. Independent of the experimentalPet flag (which gates whether it can render at all). */
  petVisible: boolean
  setPetVisible: (v: boolean) => void
  /** Which pet is active — a bundled id or a custom UUID. Persisted via PersistedUIState. */
  petId: string
  setPetId: (id: string) => void
  /** User-uploaded pet images. Metadata only — bytes live in main's userData. */
  customPets: CustomPet[]
  addCustomPet: (model: CustomPet) => void
  removeCustomPet: (id: string) => void
  /** Pet overlay size in CSS pixels (square). User-adjustable so an oversized imported sprite isn't stuck on screen. */
  petSize: number
  setPetSize: (size: number) => void
  pendingRevealWorktree: UISliceCore['pendingRevealWorktree']
  pendingRevealSidebarRow: UISliceCore['pendingRevealSidebarRow']
  revealWorktreeInSidebar: UISliceCore['revealWorktreeInSidebar']
  revealSidebarRow: UISliceCore['revealSidebarRow']
  clearPendingRevealWorktreeId: () => void
  clearPendingRevealSidebarRow: () => void
  // Why: cleared by the diff decorator after it reveals the line, so the same id can be requested again without a stale value.
  scrollToDiffCommentId: string | null
  setScrollToDiffCommentId: (id: string | null) => void
}

export type UISlicePersistence = {
  persistedUIReady: boolean
  /** Writer-owned fields as last hydrated from main or flushed by the writer; the debounced writer diffs against this so it only persists fields this client changed (STA-5781). */
  persistedUIWriteBaseline: PersistedUIWriteBaseline | null
  /** Fields with a ui.set round-trip in flight; hydration keeps the mirror's value for them so an echo of the in-flight write can't revert a newer flip-back. */
  persistedUIWriteInFlightCounts: Partial<Record<keyof PersistedUIWriteBaseline, number>>
  /** Bumped whenever hydration replaces the baseline; an ack whose write predates the bump must not fold, or it would erase a remote write that landed during the round trip. */
  persistedUIWriteBaselineGeneration: number
  notePersistedUIWriteStarted: (fields: readonly (keyof PersistedUIWriteBaseline)[]) => void
  /** Settle an in-flight write: fold the acked patch into the baseline (null = rejected, leaving the fields dirty so the next change re-flushes them). */
  notePersistedUIWriteSettled: (
    fields: readonly (keyof PersistedUIWriteBaseline)[],
    flushed: Partial<PersistedUIWriteBaseline> | null,
    options?: { sentAtGeneration: number }
  ) => void
  uiZoomLevel: number
  setUIZoomLevel: (level: number) => void
  editorFontZoomLevel: number
  setEditorFontZoomLevel: (level: number) => void
  hydratePersistedUI: (ui: PersistedUIState, source?: 'startup' | 'sync') => void
  updateStatus: UpdateStatus
  setUpdateStatus: (status: UpdateStatus) => void
  // Why: cache last-'available' changelog so the card keeps rich content while downloading; cleared on idle/checking to avoid staleness.
  updateChangelog: ChangelogData | null
  // Why: UpdateCard is lazy-loaded and may miss the transient checking status; hold manual-check intent until a terminal state consumes it.
  updateUserInitiatedCycle: boolean
  dismissedUpdateVersion: string | null
  dismissUpdate: (versionOverride?: string) => void
  clearDismissedUpdateVersion: () => void
  /** Dev-only channel override; null follows the running build's own channel. */
  releaseChannelOverride: ReleaseChannel | null
  setReleaseChannelOverride: (channel: ReleaseChannel | null) => void
  // Why: ephemeral, renderer-only — never persisted; resets each session and on every phase transition (see setUpdateStatus).
  updateCardCollapsed: boolean
  setUpdateCardCollapsed: (collapsed: boolean) => void
  updateReassuranceSeen: boolean
  markUpdateReassuranceSeen: () => void
  /** True on the launch where the OSC 52 default-on migration overrode a persisted `false`. */
  osc52ClipboardDefaultOnNoticePending: boolean
  clearOsc52ClipboardDefaultOnNotice: () => void
  isFullScreen: boolean
  setIsFullScreen: (v: boolean) => void
  /** URL opened when a new browser tab is created. Null = blank tab (default). */
  browserDefaultUrl: string | null
  setBrowserDefaultUrl: (url: string | null) => void
  browserDefaultSearchEngine: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  setBrowserDefaultSearchEngine: (engine: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null) => void
  browserDefaultZoomLevel: number
  setBrowserDefaultZoomLevel: (level: number) => void
  browserKagiSessionLink: string | null
  setBrowserKagiSessionLink: (link: string | null) => void
}
