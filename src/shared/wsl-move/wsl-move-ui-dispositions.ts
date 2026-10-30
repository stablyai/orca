import type { GlobalSettings } from '../global-settings-types'
import type { PersistedUIState } from '../persisted-ui-state-types'
import {
  moveDisposition,
  notApplicableDisposition,
  type WslMoveFieldDisposition
} from './wsl-move-dispositions'

/** UI fields that name a repo, worktree, pane or path. Everything else in the UI state is global. */
export const UI_STATE_DISPOSITIONS = {
  lastActiveRepoId: notApplicableDisposition(38, 'repoId is kept.'),
  pendingRuntimeRepoRemovals: notApplicableDisposition(
    38,
    'Owed to a paired server; a WSL move only moves local projects.'
  ),
  lastActiveWorktreeId: moveDisposition(38, { rewriteDesktopCopy: true }),
  manualRepoOrder: moveDisposition(38, {
    rewriteDesktopCopy: true,
    note: "The desktop copy's hostId changes from 'local' to the WSL host."
  }),
  explorerDisplayRootByWorktree: moveDisposition(39, {
    rewriteDesktopCopy: true,
    newManifestSection: true
  }),
  showDotfilesByWorktree: moveDisposition(38, { rewriteDesktopCopy: true }),
  filterRepoIds: moveDisposition(38),
  agentsFilterRepoIds: moveDisposition(38),
  setupScriptPromptDismissedRepoIds: moveDisposition(38),
  acknowledgedAgentsByPaneKey: moveDisposition(38, { note: 'Pane keys are kept.' }),
  activityClearedAtByPaneKey: moveDisposition(38, { note: 'Pane keys are kept.' }),
  manuallyUnreadTurnsByPaneKey: moveDisposition(38, { note: 'Pane keys are kept.' }),
  trustedOrcaHooks: notApplicableDisposition(
    40,
    'Kept by repoId, which the move keeps; wsl-moved-repo-ui-retention.ts stops the trust prune dropping it.'
  ),
  collapsedGroups: {
    disposition: 'rewrite-desktop',
    item: 38,
    note: 'Repo and project keys are kept; a collapsed host section maps to the WSL host.'
  },
  workspaceCleanup: moveDisposition(38, {
    rewriteDesktopCopy: true,
    note: 'Dismissals are keyed by worktree id.'
  }),
  workspaceHostScope: {
    disposition: 'rewrite-desktop',
    item: 38,
    note: "A 'local' focus also covers the WSL host."
  },
  workspaceHostOrder: {
    disposition: 'rewrite-desktop',
    item: 38,
    note: 'Gains the WSL host when it first owns a project.'
  },
  visibleWorkspaceHostIds: {
    disposition: 'rewrite-desktop',
    item: 38,
    note: "Must not hide the WSL host when 'local' was visible."
  },
  agentsVisibleHostIds: {
    disposition: 'rewrite-desktop',
    item: 38,
    note: "Must not hide the WSL host when 'local' was visible."
  },
  automationHostFilter: {
    disposition: 'rewrite-desktop',
    item: 38,
    note: 'Single-select: a filter on this desktop widens to All hosts once, if the move carried automations.'
  },
  jiraQuickFilterState: notApplicableDisposition(38, 'Filters belong to the Jira host.'),
  jiraSavedFilterState: notApplicableDisposition(
    38,
    'Filters belong to the Jira host, not a moved workspace.'
  ),
  taskResumeState: notApplicableDisposition(38)
} as const satisfies Partial<Record<keyof PersistedUIState, WslMoveFieldDisposition>>

export const UI_STATE_GLOBAL_FIELDS = [
  'activeView',
  'sidebarWidth',
  'sidebarOpen',
  'rightSidebarOpen',
  'rightSidebarTab',
  'rightSidebarExplorerView',
  'rightSidebarWidth',
  'markdownTocPanelWidth',
  'combinedDiffFileTreeWidth',
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'showActiveOnly',
  'hideSleepingWorkspaces',
  'showSleepingWorkspaces',
  'showInactiveWorkspaces',
  'hideDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces',
  'hideWorkspacesFromOtherDevices',
  'alwaysShowDefaultBranchWorkspace',
  'agentsHideWorkspacesFromOtherDevices',
  'agentsHideAutomationGeneratedWorkspaces',
  'agentsHideCliCreatedWorkspaces',
  'agentsShowChildAgents',
  'agentsCompactMode',
  'agentsShowSearch',
  'agentsReadFilter',
  'agentsGroupBy',
  'uiZoomLevel',
  'editorFontZoomLevel',
  'worktreeCardProperties',
  '_worktreeCardModeDefaulted',
  'agentActivityDisplayMode',
  'workspaceStatuses',
  'workspaceBoardOpacity',
  'workspaceBoardColumnWidth',
  'syncTaskStatusFromWorkspaceBoard',
  'statusBarItems',
  'statusBarVisible',
  'usagePercentageDisplay',
  'statusBarUsageMode',
  'dismissedUpdateVersion',
  'dismissedUnexpectedSignoutVersion',
  'lastUpdateCheckAt',
  'releaseChannelOverride',
  'pendingUpdateNudgeId',
  'dismissedUpdateNudgeId',
  'notificationPermissionRequested',
  'updateReassuranceSeen',
  'setupGuideSidebarDismissed',
  'setupGuideBrowserMilestoneMigrated',
  'setupGuideBrowserMilestoneLegacyComplete',
  'browserImportHintHidden',
  'trayMinimizeNoticeShown',
  'mobileEmulatorTabIntroDismissed',
  'mobileEmulatorAgentSetupDismissed',
  'projectOrderManualDefaultNoticeDismissed',
  'usagePercentageDisplayChangeNoticeDismissed',
  'statusBarCompactChangeNoticeDismissed',
  'usageEmptyStateDismissed',
  'pluginsAlphaNoticeDismissed',
  'codexTerminalServerIsolationNoticeSeen',
  'codexSharedSettingsNoticeSeen',
  'claudeDiffPanelNoticeSeen',
  'claudeAccountSignInNoticeSeen',
  'browserDefaultUrl',
  'browserDefaultSearchEngine',
  'browserDefaultZoomLevel',
  'browserKagiSessionLink',
  'browserDevToolsDock',
  'windowBounds',
  'windowMaximized',
  'dashboardPopoutBounds',
  'starNagBaselineAgents',
  'starNagAppVersion',
  'starNagNextThreshold',
  'starNagCompleted',
  'starNagDeferredUntil',
  'starNagAgentValueMomentAppVersion',
  'petVisible',
  'petId',
  'customPets',
  'petSize',
  'sidekickVisible',
  'sidekickId',
  'customSidekicks',
  'sidekickSize',
  'featureTipsSeenIds',
  'featureInteractions',
  'contextualToursSeenIds',
  'contextualToursAutoEligible',
  'osc52ClipboardDefaultOnNoticePending',
  '_antigravityStatusBarDefaultAdded',
  '_cursorStatusBarDefaultAdded',
  '_expandedWorktreeCardPropertiesDefaulted',
  '_explorerDisplayRootMigrated',
  '_grokStatusBarDefaultAdded',
  '_hostWorktreeCardPropertyDefaulted',
  '_inlineAgentsDefaultedForAllUsers',
  '_inlineAgentsDefaultedForExperiment',
  '_jiraIssueWorktreeCardPropertyDefaulted',
  '_kimiStatusBarDefaultAdded',
  '_minimaxStatusBarDefaultAdded',
  '_portsStatusBarDefaultAdded',
  '_sortBySmartMigrated',
  '_workspaceStatusesDefaultOrderMigrated',
  '_workspaceStatusesDefaultVisualsMigrated',
  '_workspaceStatusesDefaultWorkflowMigrated',
  '_workspaceStatusesReorderedDefaultRepaired',
  '_zcodeStatusBarDefaultAdded'
] as const satisfies readonly (keyof PersistedUIState)[]

// Exhaustiveness prevents moves stranding newly added workspace state.
type UnclassifiedUiField = Exclude<
  keyof PersistedUIState,
  keyof typeof UI_STATE_DISPOSITIONS | (typeof UI_STATE_GLOBAL_FIELDS)[number]
>
const uiStateExhaustive: [UnclassifiedUiField] extends [never] ? true : never = true
void uiStateExhaustive

/** Settings are desktop-global. These are the ones holding a path, each decided (item 41). */
export const SETTINGS_KEYS_NAMING_A_PATH = {
  workspaceDir: 'Desktop default for new workspaces; the host has its own.',
  floatingTerminalCwd: 'The floating terminal stays a desktop terminal; D4 rewrites a UNC cwd.',
  floatingTerminalTrustedCwds: 'Same as floatingTerminalCwd.',
  devPluginPaths: 'Desktop plugin paths.',
  agentStateRulesPath: 'Desktop file.',
  androidSdkPath: 'Desktop SDK.',
  codexSessionSourceHome:
    "Per-distro Codex history home; the host's own history scan needs it (Track E), the mover does not."
} as const satisfies Partial<Record<keyof GlobalSettings, string>>
