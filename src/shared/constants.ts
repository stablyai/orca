import type { GlobalSettings } from './global-settings-types'
import type { NotificationSettings } from './notification-settings-types'
import type { OnboardingChecklistState, OnboardingState } from './onboarding-state-types'
import type { RepoHookSettings } from './orca-yaml-hook-types'
import type { PersistedState } from './persisted-state-types'
import type { PersistedUIState } from './persisted-ui-state-types'
import type { AgentActivityDisplayMode } from './ui-chrome-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER } from './codex-reset-credit-attempt-ledger'
import { DEFAULT_STATUS_BAR_ITEMS } from './status-bar-defaults'
import type { VoiceSettings } from './speech-types'
import { cloneDefaultWorkspaceStatuses } from './workspace-statuses'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from './worktree/card-properties'
import { DEFAULT_USAGE_PERCENTAGE_DISPLAY } from './usage-percentage-display'
import { DEFAULT_STATUS_BAR_USAGE_MODE } from './status-bar-usage-mode'
import { buildDefaultSettings } from './default-global-settings'
import { DEFAULT_SETUP_AGENT_STARTUP_POLICY } from './setup-agent-startup-policy'
import { DEFAULT_BROWSER_PAGE_ZOOM_LEVEL } from './browser-page-zoom'

export { DEFAULT_STATUS_BAR_ITEMS } from './status-bar-defaults'
export {
  COMPACT_WORKTREE_CARD_PROPERTIES,
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  TASK_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardModeProperties,
  getWorktreeCardModeUpdates,
  isDefaultedCompactWorktreeCardProperties,
  normalizeWorktreeCardProperties
} from './worktree/card-properties'

export const SCHEMA_VERSION = 1
export const DEFAULT_APP_FONT_FAMILY = 'Geist'
export const DEFAULT_SHOW_SLEEPING_WORKSPACES = true
export const DEFAULT_HIDE_SLEEPING_WORKSPACES = false
export const DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE: AgentActivityDisplayMode = 'compact'
export const DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY = 0.9

export function normalizeAgentActivityDisplayMode(value: unknown): AgentActivityDisplayMode {
  return value === 'full' || value === 'compact' ? value : DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE
}

// Why: onboarding wizard's last step index, centralized so backfill, clamps, and UI agree on the bound.
export const ONBOARDING_FINAL_STEP = 5
export const ONBOARDING_FLOW_VERSION = 4

export const ORCA_BROWSER_PARTITION = 'persist:orca-browser'
// Why: inert blank-tab URL shared by main/renderer so the attach policy can allow just this one data URL and reject others.
export const ORCA_BROWSER_BLANK_URL = 'data:text/html,'

// Why: Electron's invoke error path preserves only message text, so signal reconnect via this stable token.
export const SSH_TERMINATE_RECONNECT_REQUIRED = 'SSH_TERMINATE_RECONNECT_REQUIRED'

export const BROWSER_FAMILY_LABELS: Record<string, string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  comet: 'Comet',
  helium: 'Helium',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  safari: 'Safari',
  manual: 'File'
}

// Why: only the initial value shown in Settings; buildFontFamily() adds the real cross-platform fallback chain.
function defaultTerminalFontFamily(): string {
  const platform = typeof process !== 'undefined' ? process.platform : ''
  if (platform === 'win32') {
    return 'Cascadia Mono'
  }
  if (platform === 'linux') {
    return 'DejaVu Sans Mono'
  }
  return 'SF Mono' // macOS default
}

export const getDefaultPrimarySelectionMiddleClickPaste = (
  platform = typeof process !== 'undefined' ? process.platform : ''
): boolean => platform === 'linux' || platform === 'darwin'

export const getDefaultTerminalRightClickToPaste = (
  platform = typeof process !== 'undefined' ? process.platform : ''
): boolean => platform === 'win32'

/** Why: ProseMirror renders the whole document — no virtualization — so cost is
 *  linear in file size and every keystroke re-runs it. Measured in a packaged
 *  build (M-series, `out/`), typing latency and the blocking mount on open:
 *  100 KB 17 ms / 0 ms · 200 KB 46 ms / 0 ms · 300 KB 84 ms / 1.4 s ·
 *  600 KB 265 ms / 4.2 s. 300 KB is already the knee, so this is a ceiling to
 *  hold rather than raise; past it, fall back to source mode (Monaco) with a
 *  per-file "Open anyway" escape hatch. Real headroom needs #7056. */
export const RICH_MARKDOWN_MAX_SIZE_BYTES = 300 * 1024

export const DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS = 1000
export const MIN_EDITOR_AUTO_SAVE_DELAY_MS = 250
export const MAX_EDITOR_AUTO_SAVE_DELAY_MS = 10_000

// Why: first-time seed only — doubles on each dismissal without starring; later thresholds live in starNagNextThreshold.
export const STAR_NAG_INITIAL_THRESHOLD = 35

/** Synthetic worktree id for PTYs not tied to any worktree; shared so main and renderer agree on the sentinel. */
export const ORPHAN_WORKTREE_ID = '__orphan__'

// Why: synthetic local workspace; persistence pruning must classify it without the repo catalog.
export const FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'

export const REPO_COLORS = [
  '#737373', // neutral
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#8b5cf6', // purple
  '#ec4899' // pink
] as const

export const DEFAULT_REPO_BADGE_COLOR = REPO_COLORS[0]

export function getDefaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: false,
    suppressWhenFocused: true,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 100
  }
}

export function getDefaultOnboardingState(): OnboardingState {
  return {
    flowVersion: ONBOARDING_FLOW_VERSION,
    closedAt: null,
    outcome: null,
    lastCompletedStep: -1,
    checklist: {
      addedRepo: false,
      choseAgent: false,
      ranFirstAgent: false,
      ranSecondAgentOnSameTask: false,
      triedCmdJ: false,
      shapedSidebar: false,
      reviewedDiff: false,
      openedPr: false,
      addedFolder: false,
      openedFile: false,
      ranAgentOnFile: false,
      dismissed: false
    } satisfies OnboardingChecklistState
  }
}

/** The stock worktree root. Exported so callers can tell an untouched default apart
 *  from a workspace directory the user actually chose. */
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
    language: 'en',
    dictationMode: 'toggle' as const,
    terminalConfirmBeforeInsert: false,
    userModels: [],
    openAiApiKeyConfigured: false,
    microphoneDeviceId: null,
    microphoneDeviceLabel: null
  }
}

export function getDefaultRepoHookSettings(): RepoHookSettings {
  return {
    mode: 'auto',
    setupRunPolicy: 'run-by-default',
    setupAgentStartupPolicy: DEFAULT_SETUP_AGENT_STARTUP_POLICY,
    scripts: {
      setup: '',
      archive: ''
    }
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
    claudeLivePtySessionIds: [],
    migrationUnsupportedPtyEntries: [],
    legacyPaneKeyAliasEntries: [],
    automations: [],
    automationRuns: [],
    onboarding: getDefaultOnboardingState(),
    featureInteractionTelemetryBuckets: {},
    codexResetCreditAttemptLedger: structuredClone(EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER)
  }
}

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
    showDotfilesByWorktree: {},
    filterRepoIds: [],
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    _worktreeCardModeDefaulted: true,
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
    dismissedUpdateVersion: null,
    lastUpdateCheckAt: null,
    trustedOrcaHooks: {},
    setupScriptPromptDismissedRepoIds: [],
    acknowledgedAgentsByPaneKey: {},
    setupGuideSidebarDismissed: false,
    setupGuideBrowserMilestoneMigrated: true,
    setupGuideBrowserMilestoneLegacyComplete: false,
    browserImportHintHidden: false,
    trayMinimizeNoticeShown: false,
    // Why: fresh profiles start on the new default, so nothing was overridden to report.
    osc52ClipboardDefaultOnNoticePending: false,
    mobileEmulatorTabIntroDismissed: false,
    mobileEmulatorAgentSetupDismissed: false,
    // Why: only upgraded profiles saw the old ordering, so only they get the one-time notice.
    projectOrderManualDefaultNoticeDismissed: true,
    // Why: only upgraded profiles saw the old default, so only they get the one-time change notice.
    usagePercentageDisplayChangeNoticeDismissed: true,
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
