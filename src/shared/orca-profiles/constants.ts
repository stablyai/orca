import { DEFAULT_APP_FONT_FAMILY } from '../app-lifecycle/appearance/app-font-family'
import { DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS } from '../editor/saving/editor-auto-save-delay'
import { DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY } from '../terminal/appearance/terminal-pane-opacity'
import {
  DEFAULT_SHOW_SLEEPING_WORKSPACES,
  DEFAULT_HIDE_SLEEPING_WORKSPACES
} from '../workspace-view/sleeping-workspace-visibility'
import { DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE } from '../agent-status/presentation/agent-activity-display-mode'
import type { GlobalSettings } from '../settings/global-settings-types'
import type { PersistedState } from './persisted-state-types'
import type { PersistedUIState } from './persisted-ui-state-types'

import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'
import { EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER } from '../agent-accounts/codex/codex-reset-credit-attempt-ledger'
import { DEFAULT_STATUS_BAR_ITEMS } from '../status-bar/status-bar-defaults'
import type { VoiceSettings } from '../speech/speech-types'
import { DICTATION_LANGUAGE_AUTO } from '../speech/models/dictation-language'
import { DEFAULT_UNLOAD_MODEL_AFTER_MINUTES } from '../speech/models/voice-model-unload'
import { cloneDefaultWorkspaceStatuses } from '../workspace/status/workspace-statuses'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../worktree/row-display/card-properties'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../bots/bot-sidebar-view'
import {
  DEFAULT_AGENTS_GROUP_BY,
  DEFAULT_AGENTS_READ_FILTER
} from '../agent-status/presentation/agents-view-thread-filters'
import { DEFAULT_USAGE_PERCENTAGE_DISPLAY } from '../agent-usage/display/usage-percentage-display'
import { DEFAULT_STATUS_BAR_USAGE_MODE } from '../status-bar/status-bar-usage-mode'
import { DEFAULT_STATUS_BAR_USAGE_FORMAT } from '../status-bar/status-bar-usage-format'
import { buildDefaultSettings } from '../settings/default-global-settings'
import { DEFAULT_BROWSER_PAGE_ZOOM_LEVEL } from '../browser/site-settings/browser-page-zoom'
import { getDefaultNotificationSettings } from '../notifications/notification-settings-defaults'
import { getDefaultOnboardingState } from '../onboarding/onboarding-defaults'
import {
  defaultTerminalFontFamily,
  defaultTerminalFontWeight,
  getDefaultPrimarySelectionMiddleClickPaste,
  getDefaultTerminalRightClickToPaste
} from '../terminal/appearance/terminal-platform-defaults'

export const SCHEMA_VERSION = 1

/** Expose the stock root so callers can distinguish an untouched default from a user-selected directory. */
export function getDefaultWorkspaceDir(homeDir: string): string {
  const separator = homeDir.includes('\\') ? '\\' : '/'
  const trimmedHomeDir = homeDir.replace(/[\\/]+$/, '')
  return [trimmedHomeDir, 'orca', 'workspaces'].join(separator)
}

export function getDefaultSettings(homedir: string): GlobalSettings {
  return buildDefaultSettings({
    workspaceDir: getDefaultWorkspaceDir(homedir),
    appFontFamily: DEFAULT_APP_FONT_FAMILY,
    editorAutoSaveDelayMs: DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
    primarySelectionMiddleClickPaste: getDefaultPrimarySelectionMiddleClickPaste(),
    primarySelectionDefaultedForLinux:
      typeof process !== 'undefined' && process.platform === 'linux',
    terminalFontFamily: defaultTerminalFontFamily(),
    terminalFontWeight: defaultTerminalFontWeight(),
    // Fresh Windows profiles start on Regular, so a later 500 is a choice, not the old default.
    terminalFontWeightWindowsRegular:
      typeof process !== 'undefined' && process.platform === 'win32' ? 'done' : undefined,
    terminalInactivePaneOpacity: DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY,
    terminalRightClickToPaste: getDefaultTerminalRightClickToPaste(),
    notifications: getDefaultNotificationSettings(),

    voice: getDefaultVoiceSettings()
  })
}

export function getDefaultVoiceSettings(): VoiceSettings {
  return {
    enabled: false,
    sttModel: '',
    modelsDir: '',
    dictationLanguage: DICTATION_LANGUAGE_AUTO,
    dictationMode: 'toggle' as const,
    dictationHoldToRecord: true,
    removeFillerWords: true,
    terminalConfirmBeforeInsert: false,
    openAiApiKeyConfigured: false,
    microphoneDeviceId: null,
    microphoneDeviceLabel: null,
    unloadModelAfterMinutes: DEFAULT_UNLOAD_MODEL_AFTER_MINUTES
  }
}

export function getDefaultPersistedState(homedir: string): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    repos: [],
    projects: [],
    projectHostSetups: [],
    projectGroups: [],
    folderWorkspaces: [],
    sparsePresetsByRepo: {},
    retiredWorktreeNamesByRepo: {},
    retiredWorktreeNamesByNamespace: {},
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    settings: getDefaultSettings(homedir),
    ui: getDefaultUIState(),
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession(),
    workspaceSessionsByHostId: {},
    sshTargets: [],
    sshTargetGenerationCounter: 0,
    deletedSshConfigAliases: [],
    sshRemotePtyLeases: [],
    sshPtyConsumerRecoveries: [],
    migrationUnsupportedPtyEntries: [],
    legacyPaneKeyAliasEntries: [],
    automations: [],
    automationRuns: [],
    onboarding: getDefaultOnboardingState(),
    featureInteractionTelemetryBuckets: {},
    codexResetCreditAttemptLedger: structuredClone(EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER)
  }
}

/** Creates fresh UI defaults with completed migration markers so new profiles are not treated as legacy installations. */
export function getDefaultUIState(): PersistedUIState {
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    activeView: 'terminal',
    sidebarWidth: 280,
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    rightSidebarWidth: 350,
    activityBarPosition: 'top',
    markdownTocPanelWidth: 240,
    combinedDiffFileTreeWidth: 256,
    groupBy: 'repo',
    sortBy: 'recent',
    projectOrderBy: 'manual',
    showActiveOnly: false,
    hideSleepingWorkspaces: DEFAULT_HIDE_SLEEPING_WORKSPACES,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    workspaceHostOrder: [],
    automationHostFilter: { kind: 'all' },
    manualRepoOrder: [],
    showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    _explorerDisplayRootMigrated: true,
    explorerDisplayRootByWorktree: {},
    showDotfilesByWorktree: {},
    notificationsMutedByWorktree: {},
    filterRepoIds: [],
    agentsVisibleHostIds: null,
    agentsFilterRepoIds: [],
    agentsHideWorkspacesFromOtherDevices: false,
    agentsHideAutomationGeneratedWorkspaces: false,
    agentsHideCliCreatedWorkspaces: false,
    hideBotCreatedWorkspaces: true,
    botSidebarView: DEFAULT_BOT_SIDEBAR_VIEW,
    agentsShowChildAgents: false,
    agentsCompactMode: true,
    agentsShowSearch: true,
    agentsReadFilter: DEFAULT_AGENTS_READ_FILTER,
    agentsGroupBy: DEFAULT_AGENTS_GROUP_BY,
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    _worktreeCardModeDefaulted: true,
    showAgentModels: true,
    workerTabsMode: 'open-when-clicked',
    agentActivityDisplayMode: DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    workspaceBoardOpacity: 1,
    workspaceBoardColumnWidth: 308,
    syncTaskStatusFromWorkspaceBoard: false,
    _workspaceStatusesDefaultOrderMigrated: true,
    _workspaceStatusesReorderedDefaultRepaired: true,
    _workspaceStatusesDefaultWorkflowMigrated: true,
    _workspaceStatusesDefaultVisualsMigrated: true,
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    statusBarVisible: true,
    usagePercentageDisplay: DEFAULT_USAGE_PERCENTAGE_DISPLAY,
    statusBarUsageMode: DEFAULT_STATUS_BAR_USAGE_MODE,
    statusBarUsageFormat: { ...DEFAULT_STATUS_BAR_USAGE_FORMAT },
    dismissedUpdateVersion: null,
    dismissedUnexpectedSignoutVersion: null,
    lastUpdateCheckAt: null,
    trustedOrcaHooks: {},
    setupScriptPromptDismissedRepoIds: [],
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    setupGuideSidebarDismissed: false,
    setupGuideBrowserMilestoneMigrated: true,
    setupGuideBrowserMilestoneLegacyComplete: false,
    browserImportHintHidden: false,
    trayMinimizeNoticeShown: false,
    // Why: fresh profiles start on the new default, so nothing was overridden to report.
    osc52ClipboardDefaultOnNoticePending: false,
    mobileEmulatorTabIntroDismissed: false,
    mobileEmulatorAgentSetupDismissed: false,
    pluginsAlphaNoticeDismissed: false,
    // Why: only upgraded profiles saw the old ordering, so only they get the one-time notice.
    projectOrderManualDefaultNoticeDismissed: true,
    // Why: only upgraded profiles saw the old default, so only they get the one-time change notice.
    usagePercentageDisplayChangeNoticeDismissed: true,
    statusBarCompactChangeNoticeDismissed: true,
    workspaceCleanup: { dismissals: {} },
    featureTipsSeenIds: [],
    featureInteractions: {},
    contextualToursSeenIds: [],
    browserDefaultZoomLevel: DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
  }
}

export function getDefaultWorkspaceSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {},
    markdownFrontmatterVisible: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserUrlHistory: [],
    defaultTerminalTabsAppliedByWorktreeId: {}
  }
}
