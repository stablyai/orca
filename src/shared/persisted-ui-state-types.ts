import type { ReleaseChannel } from './release-channel'
import type { WorkspaceCleanupUIState } from './workspace-cleanup'
import type { FeatureTipId } from './feature-tips'
import type { ContextualTourId } from './contextual-tours'
import type { FeatureInteractionState } from './feature-interactions'
import type { UsagePercentageDisplay } from './usage-percentage-display'
import type { StatusBarUsageMode } from './status-bar-usage-mode'
import type { PersistedTrustedOrcaHooks } from './orca-yaml-hook-types'
import type { CustomPet } from './pet-types'
import type {
  AgentActivityDisplayMode,
  ManualRepoOrderEntry,
  ProjectOrderBy,
  RightSidebarExplorerView,
  RightSidebarTab,
  StatusBarItem,
  TaskResumeState,
  TopLevelView,
  VisibleWorkspaceHostIds,
  WorkspaceHostOrder,
  WorkspaceHostScope,
  WorktreeCardProperty
} from './ui-chrome-types'
import type { WorkspaceStatusDefinition } from './worktree/types'
import type { PersistedAutomationHostFilter } from './automation-host-filter'

export type PersistedUIState = {
  lastActiveRepoId: string | null
  lastActiveWorktreeId: string | null
  /** Active top-level view at save time, restored on relaunch; sanitized to 'terminal' if unknown or now-gated. */
  activeView: TopLevelView
  sidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarTab: RightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarWidth: number
  markdownTocPanelWidth?: number
  combinedDiffFileTreeWidth?: number
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  /** Project header ordering in `groupBy: 'repo'`, independent of `sortBy`: 'manual' uses persisted order + header drag, 'recent' by latest visible activity. */
  projectOrderBy: ProjectOrderBy
  /** Deprecated; the Active only filter is retired and ignored on hydration. */
  showActiveOnly: boolean
  /** Hide sleeping/inactive workspaces from workspace navigation. Off by default. */
  hideSleepingWorkspaces?: boolean
  /** Which execution hosts the sidebar shows; `all` = mixed view, specific IDs focus without tearing down other hosts' sessions. */
  workspaceHostScope?: WorkspaceHostScope
  /** Which execution hosts the sidebar shows; `null` = sticky all-hosts so new hosts appear automatically. */
  visibleWorkspaceHostIds?: VisibleWorkspaceHostIds
  /** User-defined sidebar order for host sections; missing/new hosts append in discovered order. */
  workspaceHostOrder?: WorkspaceHostOrder
  /** Automations page host filter. Stores only a canonical host key; invalid values degrade to all hosts. */
  automationHostFilter?: PersistedAutomationHostFilter
  /** Desktop-owned all-host repo order; host-qualified identities keep a manual cross-host interleaving while each host owns its local permutation. */
  manualRepoOrder?: ManualRepoOrderEntry[]
  /** Deprecated legacy positive-form setting. Ignored on hydration. */
  showSleepingWorkspaces?: boolean
  /** Deprecated legacy name used by a short-lived build. Ignored on hydration. */
  showInactiveWorkspaces?: boolean
  /** Hide the repo's checked-out branch from workspace nav (sidebar, Cmd+J); folder-mode repos are unaffected (empty-branch worktrees excluded). */
  hideDefaultBranchWorkspace: boolean
  /** Hide workspaces created by automation new-per-run dispatches. */
  hideAutomationGeneratedWorkspaces?: boolean
  /** Hide workspaces created through `orca worktree create`. */
  hideCliCreatedWorkspaces?: boolean
  /** Hide workspaces sitting on a detached HEAD; folder workspaces (no head at all) are unaffected. */
  hideDetachedHeadWorkspaces?: boolean
  /** Hide workspaces with known provenance from another paired device or the host UI. */
  hideWorkspacesFromOtherDevices?: boolean
  /** Keep each project's main workspace out of the "Hide sleeping" sweep. Absent means on (#8873). */
  alwaysShowDefaultBranchWorkspace?: boolean
  /** Per-worktree Explorer dotfile visibility. Missing entries inherit the default: show. */
  showDotfilesByWorktree?: Record<string, boolean>
  filterRepoIds: string[]
  /** Agents-view host scope; deliberately separate from visibleWorkspaceHostIds so a monitoring surface never inherits nav filters silently. `null` = all hosts. */
  agentsVisibleHostIds?: VisibleWorkspaceHostIds
  /** Agents-view project filter; empty = all projects. Separate from filterRepoIds (workspace nav). */
  agentsFilterRepoIds?: string[]
  /** Agents-view: include child (orchestration-dispatched) agent threads. Absent means off. */
  agentsShowChildAgents?: boolean
  /** Agents-view compact thread rows. Absent means on. */
  agentsCompactMode?: boolean
  collapsedGroups: string[]
  uiZoomLevel: number
  editorFontZoomLevel: number
  worktreeCardProperties: WorktreeCardProperty[]
  /** One-shot migration flag for deriving card properties from the two worktree card modes. */
  _worktreeCardModeDefaulted?: boolean
  agentActivityDisplayMode?: AgentActivityDisplayMode
  workspaceStatuses?: WorkspaceStatusDefinition[]
  workspaceBoardOpacity?: number
  workspaceBoardColumnWidth?: number
  syncTaskStatusFromWorkspaceBoard?: boolean
  /** One-shot migration flag for a short-lived build that persisted default statuses in reverse order; once stamped, ordering is never re-inferred from IDs/labels. */
  _workspaceStatusesDefaultOrderMigrated?: boolean
  /** One-shot repair flag for the exact default payload a short-lived build persisted in reverse workflow order. */
  _workspaceStatusesReorderedDefaultRepaired?: boolean
  /** One-shot migration flag for default status workflow labels/visuals; only exact legacy defaults migrate, customized statuses preserved. */
  _workspaceStatusesDefaultWorkflowMigrated?: boolean
  /** One-shot migration flag for the old default status visuals; once stamped, user-authored colors/icons are preserved. */
  _workspaceStatusesDefaultVisualsMigrated?: boolean
  /** One-shot migration flag for adding the default-on Ports status item. */
  _portsStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Kimi status item. */
  _kimiStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on MiniMax status item. */
  _minimaxStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Antigravity status item. */
  _antigravityStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Grok status item. */
  _grokStatusBarDefaultAdded?: boolean
  statusBarItems: StatusBarItem[]
  statusBarVisible: boolean
  /** Why: this is client-side presentation, not a provider/account or execution-host setting. */
  usagePercentageDisplay?: UsagePercentageDisplay
  /** Client-side footer presentation; verbose preserves the pre-roster all-window default. */
  statusBarUsageMode?: StatusBarUsageMode
  dismissedUpdateVersion: string | null
  lastUpdateCheckAt: number | null
  /** Dev-only update channel override; absent means the build's own channel. */
  releaseChannelOverride?: ReleaseChannel | null
  pendingUpdateNudgeId?: string | null
  dismissedUpdateNudgeId?: string | null
  /** Whether Orca already tried triggering the macOS notification permission dialog; prevents re-firing every launch. */
  notificationPermissionRequested?: boolean
  /** Once the "your sessions won't be interrupted" reassurance card is seen, never show it again. */
  updateReassuranceSeen?: boolean
  /** Per-paneKey "row visited" timestamps that mute seen inline-agent rows; persisted because rows survive restart, else acked rows return bold. Renderer-owned via ui:set. */
  acknowledgedAgentsByPaneKey?: Record<string, number>
  /** Per-paneKey "Clear completed" cutoffs hiding activity events stamped at or before the cutoff; persisted so cleared rows stay cleared across restart. Renderer-owned via ui:set. */
  activityClearedAtByPaneKey?: Record<string, number>
  /** Per-paneKey turn stamps the user explicitly marked unread; persisted so a manual unread survives restart the way acks and cutoffs do. Renderer-owned via ui:set. */
  manuallyUnreadTurnsByPaneKey?: Record<string, number>
  /** User-hidden setup-guide sidebar entry; a reversible declutter pref (Help menu stays available), not completion. */
  setupGuideSidebarDismissed?: boolean
  /** One-shot marker for the browser setup-guide milestone; profiles missing it are evaluated once in the renderer (completion needs runtime probes). */
  setupGuideBrowserMilestoneMigrated?: boolean
  /** Existing users who completed/dismissed the pre-browser checklist stay complete after the browser milestone is added. */
  setupGuideBrowserMilestoneLegacyComplete?: boolean
  /** User-dismissed browser import toolbar hint; import stays available from Settings > Browser and the overflow menu. */
  browserImportHintHidden?: boolean
  /** Why: Windows-only. Set once on first hide to tray so the "Orca is still running" notice shows only once. */
  trayMinimizeNoticeShown?: boolean
  /** Set by the OSC 52 default-on migration when it overrode a persisted `false`; the renderer shows one notice and clears it. */
  osc52ClipboardDefaultOnNoticePending?: boolean
  /** User dismissed the first-run Mobile Emulator intro; reversible only by re-enabling the feature in Settings. */
  mobileEmulatorTabIntroDismissed?: boolean
  /** User deferred the in-pane Mobile Emulator CLI + skill setup guide. */
  mobileEmulatorAgentSetupDismissed?: boolean
  /** One-shot rollout notice for manual project ordering default; absent or true keeps the sidebar callout hidden. */
  projectOrderManualDefaultNoticeDismissed?: boolean
  /** One-shot notice that usage meters show percent used, not remaining; absent resolves on load (new profiles dismissed, upgraded see it once). */
  usagePercentageDisplayChangeNoticeDismissed?: boolean
  /** User-hidden empty-state usage CTA; permanently hides the "Connect AI accounts" prompt even if providers are later disconnected. */
  usageEmptyStateDismissed?: boolean
  /** URL for new browser tabs; null = blank tab. */
  browserDefaultUrl?: string | null
  browserDefaultSearchEngine?: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  /** Electron browser zoom level applied when a new local browser tab is created. */
  browserDefaultZoomLevel?: number
  /** Optional Kagi private-session link used only when Kagi is the search engine. */
  browserKagiSessionLink?: string | null
  /** Saved window bounds so the app restores last position/size instead of maximizing each launch. */
  windowBounds?: { x: number; y: number; width: number; height: number } | null
  /** Whether the window was maximized when it was last closed. */
  windowMaximized?: boolean
  /** Saved bounds for the pop-out dashboard window so it restores to its last
   *  position/size. Independent of the main window's bounds. */
  dashboardPopoutBounds?: { x: number; y: number; width: number; height: number } | null
  /** One-shot flag: 'recent' once meant the smart sort (v1→v2 rename), migrated to 'smart' once so the new last-activity 'recent' isn't re-clobbered. */
  _sortBySmartMigrated?: boolean
  /** LEGACY inline-agents flag, stamped unconditionally every load so it can't gate migration; kept only for rollback forward-compat (real gate: _inlineAgentsDefaultedForAllUsers). */
  _inlineAgentsDefaultedForExperiment?: boolean
  /** One-shot flag for the inline-agents default-on rollout; distinct from _inlineAgentsDefaultedForExperiment, which was stamped every load and is permanently dirty. */
  _inlineAgentsDefaultedForAllUsers?: boolean
  /** One-shot migration flag for split-out card properties, set once so later deliberate unchecks of Linear issue/Ports stick across restarts. */
  _expandedWorktreeCardPropertiesDefaulted?: boolean
  /** One-shot backfill flag for 'jira-issue', which joined the defaults after the expansion migration had already stamped upgraded profiles. */
  _jiraIssueWorktreeCardPropertyDefaulted?: boolean
  /** totalAgentsSpawned snapshot at first sighting of the current app version, so the nag counts agents since last update (not from zero). */
  starNagBaselineAgents?: number | null
  /** App version that set the current baseline; a version change re-captures the baseline on next spawn, restarting the nag countdown. */
  starNagAppVersion?: string | null
  /** Next agents-since-baseline threshold that fires the star-nag; starts at 35, doubles per dismissal without starring. */
  starNagNextThreshold?: number
  /** Once the user has starred Orca (any entry point), permanently suppress the nag. */
  starNagCompleted?: boolean
  /** Timestamp until which nonterminal dismissals suppress threshold prompts (force-show bypasses for dev/testing). */
  starNagDeferredUntil?: number | null
  /** App version that consumed the first value-moment ask; main-owned so remote/web clients can't spoof the once-per-version cap. */
  starNagAgentValueMomentAppVersion?: string | null
  trustedOrcaHooks?: PersistedTrustedOrcaHooks
  setupScriptPromptDismissedRepoIds?: string[]
  /** Pet overlay visibility, separate from the experimentalPet settings flag so "Hide pet" is a reversible dismiss; absent = true. */
  petVisible?: boolean
  /** Active pet id (bundled id or custom UUID); unknown ids fall back to the default on read so a removed custom pet doesn't blank the overlay. */
  petId?: string
  /** Metadata index for user-uploaded pet images; bytes live under legacy userData/sidekicks/custom/. */
  customPets?: CustomPet[]
  /** Pet overlay size in CSS pixels (square); clamped to [PET_SIZE_MIN, PET_SIZE_MAX] on read. */
  petSize?: number
  /** Legacy keys from before the sidekick -> pet rename; read only during migration, new writes use pet* above. */
  sidekickVisible?: boolean
  sidekickId?: string
  customSidekicks?: CustomPet[]
  sidekickSize?: number
  /** Page-position state for Tasks: only transient tabs/searches (source/repo/team/project selections use their own settings paths). */
  taskResumeState?: TaskResumeState
  workspaceCleanup?: WorkspaceCleanupUIState
  /** Feature tips already surfaced; startup opens the tips modal only when a current tip id is missing here. */
  featureTipsSeenIds?: FeatureTipId[]
  /** Feature ids the user has actually used; education surfaces skip teaching already-discovered features. */
  featureInteractions?: FeatureInteractionState
  /** Contextual tours already surfaced; unknown ids ignored on hydration for downgrade/upgrade forward-compat. */
  contextualToursSeenIds?: ContextualTourId[]
  /** Whether this profile may receive automatic contextual tours; missing = renderer hasn't classified the profile yet. */
  contextualToursAutoEligible?: boolean
}
