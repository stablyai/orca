/* eslint-disable max-lines -- Why: default persisted settings live in one schema-shaped object so migrations and tests compare against one source of truth. */
import type {
  GlobalSettings,
  NotificationSettings,
  OnboardingChecklistState,
  OnboardingState,
  PersistedState,
  PersistedUIState,
  RepoHookSettings,
  WorkspaceSessionState,
  AgentActivityDisplayMode
} from './types'
import { DEFAULT_STATUS_BAR_ITEMS } from './status-bar-defaults'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from './terminal-fonts'
import { getDefaultTerminalQuickCommands } from './terminal-quick-commands'
import type { VoiceSettings } from './speech-types'
import { cloneDefaultWorkspaceStatuses } from './workspace-statuses'
import { TASK_PROVIDERS } from './task-providers'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from './worktree-card-properties'
import { getDefaultSourceControlAiSettings } from './source-control-ai'
import { DEFAULT_APP_ICON_ID } from './app-icon'
import { DEFAULT_OPEN_IN_APPLICATIONS } from './open-in-applications'
import { DEFAULT_BROWSER_PAGE_ZOOM_LEVEL } from './browser-page-zoom'
import { DEFAULT_DISABLED_TUI_AGENTS } from './tui-agent-selection'
import { DEFAULT_TUI_AGENT_ARGS, DEFAULT_TUI_AGENT_ENV } from './tui-agent-launch-defaults'
import { UI_LANGUAGE_SYSTEM } from './ui-language'
import {
  DEFAULT_LEFT_SIDEBAR_TINT_COLOR,
  DEFAULT_LEFT_SIDEBAR_TINT_OPACITY
} from './left-sidebar-appearance'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from './source-control-group-order'
import { DEFAULT_SETUP_AGENT_STARTUP_POLICY } from './setup-agent-startup-policy'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from './terminal-scrollback-policy'

export { DEFAULT_STATUS_BAR_ITEMS } from './status-bar-defaults'
export {
  COMPACT_WORKTREE_CARD_PROPERTIES,
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  TASK_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardModeProperties,
  getWorktreeCardModeUpdates,
  isDefaultedCompactWorktreeCardProperties,
  normalizeWorktreeCardProperties
} from './worktree-card-properties'

export const SCHEMA_VERSION = 1
export const DEFAULT_APP_FONT_FAMILY = 'Geist'
export const DEFAULT_SHOW_SLEEPING_WORKSPACES = true
export const DEFAULT_HIDE_SLEEPING_WORKSPACES = false
export const DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE: AgentActivityDisplayMode = 'compact'

export function normalizeAgentActivityDisplayMode(value: unknown): AgentActivityDisplayMode {
  return value === 'full' || value === 'compact' ? value : DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE
}

// Why: the onboarding wizard's last step index. Centralized so backfill,
// clamps, and UI step references all agree on the same upper bound.
export const ONBOARDING_FINAL_STEP = 5
export const ONBOARDING_FLOW_VERSION = 4

export const ORCA_BROWSER_PARTITION = 'persist:orca-browser'
// Why: blank browser tabs must start from an inert guest URL that does not
// navigate the privileged main window to about:blank. Renderer and main both
// need the exact same value so the attach policy can allow only this one safe
// data URL while still rejecting arbitrary renderer-provided data URLs.
export const ORCA_BROWSER_BLANK_URL = 'data:text/html,'

// Why: Electron's invoke error path preserves message text, not arbitrary
// custom Error fields. Keep this stable token shared across main/renderer.
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

// Pick a default terminal font that is likely to exist on the current OS.
// buildFontFamily() adds the full cross-platform fallback chain, so this only
// affects what users see in Settings as the initial value.
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

/**
 * Why: ProseMirror builds an in-memory tree for the entire document, so large
 * markdown files cause noticeable typing lag in the rich editor. Files above
 * this threshold fall back to source mode (Monaco) which handles large files
 * efficiently via virtualized line rendering.
 */
export const RICH_MARKDOWN_MAX_SIZE_BYTES = 300 * 1024

export const DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS = 1000
export const MIN_EDITOR_AUTO_SAVE_DELAY_MS = 250
export const MAX_EDITOR_AUTO_SAVE_DELAY_MS = 10_000

// Why: initial threshold of agents spawned (since last update) before we show
// the star-on-GitHub notification. Doubles each time the user dismisses
// without starring — e.g. 35 → 70 → 140 → 280. Past dismissals are encoded
// in starNagNextThreshold, so this constant is only the first-time seed.
export const STAR_NAG_INITIAL_THRESHOLD = 35

/** Synthetic worktree id used by the memory collector to bucket PTYs that
 *  are not associated with any worktree. Shared across main and renderer so
 *  the collector and the status-bar popover agree on the sentinel. */
export const ORPHAN_WORKTREE_ID = '__orphan__'

// Why: the floating workspace is a local synthetic workspace, so persistence
// pruning must classify it without consulting the repo catalog.
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

function getDefaultWorkspaceDir(homeDir: string): string {
  const separator = homeDir.includes('\\') ? '\\' : '/'
  const trimmedHomeDir = homeDir.replace(/[\\/]+$/, '')
  return [trimmedHomeDir, 'orca', 'workspaces'].join(separator)
}

export function getDefaultSettings(homedir: string): GlobalSettings {
  return {
    workspaceDir: getDefaultWorkspaceDir(homedir),
    nestWorkspaces: true,
    workspaceDirHistory: [],
    refreshLocalBaseRefOnWorktreeCreate: false,
    localBaseRefSuggestionDismissed: false,
    autoRenameBranchFromWork: true,
    autoRenameBranchFromWorkDefaultedOn: true,
    branchPrefix: 'git-username',
    branchPrefixCustom: '',
    enableGitHubAttribution: false,
    theme: 'system',
    leftSidebarAppearanceMode: 'default',
    leftSidebarTintColor: DEFAULT_LEFT_SIDEBAR_TINT_COLOR,
    leftSidebarTintOpacity: DEFAULT_LEFT_SIDEBAR_TINT_OPACITY,
    uiLanguage: UI_LANGUAGE_SYSTEM,
    appIcon: DEFAULT_APP_ICON_ID,
    appFontFamily: DEFAULT_APP_FONT_FAMILY,
    editorAutoSave: false,
    editorAutoSaveDelayMs: DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
    editorMinimapEnabled: false,
    richMarkdownSpellcheckEnabled: true,
    markdownReviewToolsEnabled: true,
    primarySelectionMiddleClickPaste: getDefaultPrimarySelectionMiddleClickPaste(),
    primarySelectionMiddleClickPasteDefaultedForLinux:
      typeof process !== 'undefined' && process.platform === 'linux',
    primarySelectionMiddleClickPasteDefaultedForTerminalDefaults:
      getDefaultPrimarySelectionMiddleClickPaste(),
    terminalFontSize: 14,
    terminalFontFamily: defaultTerminalFontFamily(),
    terminalFontWeight: DEFAULT_TERMINAL_FONT_WEIGHT,
    terminalLineHeight: 1,
    terminalScrollSensitivity: 1.15,
    terminalFastScrollSensitivity: 5,
    terminalTuiScrollSensitivity: 1,
    terminalTuiScrollSensitivityDefaultedToOne: true,
    // Why: "auto" should use WebGL when supported while keeping DOM fallback
    // for renderer failures and Linux software/unknown GPU renderers.
    terminalGpuAcceleration: 'auto',
    // Why 'auto': when the user has picked a known ligature font we want the
    // feature enabled by default, but we never force it if they pick a font
    // that lacks ligatures or if they've explicitly opted out. The resolver
    // is in shared/terminal-ligatures.ts.
    terminalLigatures: 'auto',
    terminalCursorStyle: 'block',
    terminalCursorStyleDefaultedToBlock: true,
    terminalCursorBlink: true,
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalDividerColorDark: '#3f3f46',
    terminalUseSeparateLightTheme: true,
    terminalThemeLight: 'Builtin Tango Light',
    terminalCustomThemes: [],
    terminalDividerColorLight: '#d4d4d8',
    terminalInactivePaneOpacity: 0.8,
    terminalActivePaneOpacity: 1,
    terminalPaneOpacityTransitionMs: 140,
    terminalDividerThicknessPx: 3,
    // Default true so Windows users get native right-click paste out of the
    // box. Other platforms ignore this field because the UI never exposes it,
    // and Ctrl+right-click still opens the context menu when paste is enabled.
    terminalRightClickToPaste: true,
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsWslDistro: null,
    localAccountRuntime: 'host',
    localAccountWslDistro: null,
    localWindowsRuntimeDefault: { kind: 'windows-host' },
    // Why: Windows users expect "PowerShell" to mean modern PowerShell when it
    // is installed, with a safe fallback to the inbox Windows PowerShell.
    terminalWindowsPowerShellImplementation: 'auto',
    terminalMouseHideWhileTyping: false,
    terminalQuickCommands: getDefaultTerminalQuickCommands(),
    // Default false: opt-in only (matches Ghostty's default). Existing users
    // on upgrade inherit this default via persistence.ts's
    // { ...defaults.settings, ...parsed.settings } merge, so enabling
    // focus-follows-mouse never happens unexpectedly.
    terminalFocusFollowsMouse: false,
    windowBackgroundBlur: false,
    minimizeToTrayOnClose: false,
    terminalClipboardOnSelect: false,
    // Why: OSC 52 is a classic data-exfiltration vector (any process piping
    // untrusted output into the terminal can rewrite the clipboard). Keep the
    // conservative default off; users who need Grok/tmux/nvim remote copy can
    // enable the toggle. OSC 52 *query* remains disabled separately.
    terminalAllowOsc52Clipboard: false,
    claudeAgentTeamsMode: 'off',
    setupScriptLaunchMode: 'new-tab',
    terminalScrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    httpProxyUrl: '',
    httpProxyBypassRules: '',
    electronHttp1CompatibilityMode: false,
    openLinksInApp: false,
    localhostWorktreeLabelsEnabled: false,
    openLinksInAppPreferencePrompted: false,
    openAgentTabsInChatByDefault: false,
    experimentalNativeChat: false,
    openInApplications: [...DEFAULT_OPEN_IN_APPLICATIONS],
    rightSidebarOpenByDefault: true,
    showGitIgnoredFiles: true,
    sourceControlViewMode: 'list',
    sourceControlGroupOrder: DEFAULT_SOURCE_CONTROL_GROUP_ORDER,
    sourceControlCompareAgainstUpstream: false,
    showTitlebarAppName: true,
    showTasksButton: true,
    showAutomationsButton: true,
    showMobileButton: true,
    ctrlTabOrderMode: 'mru',
    // Why: switching worktrees and opening command surfaces from a focused
    // terminal is a core Orca workflow; users who prefer TUI ownership opt in.
    terminalShortcutPolicy: 'orca-first',
    floatingTerminalEnabled: true,
    floatingTerminalDefaultedForAllUsers: true,
    floatingTerminalCwd: '~',
    floatingTerminalTrustedCwds: [],
    floatingTerminalCwdMigratedToAppWorkspace: true,
    floatingTerminalTriggerLocation: 'floating-button',
    notifications: getDefaultNotificationSettings(),
    diffDefaultView: 'inline',
    diffWordWrap: false,
    combinedDiffFileTreeVisibleByDefault: false,
    promptCacheTimerEnabled: false,
    promptCacheTtlMs: 300_000,
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} },
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    terminalScopeHistoryByWorktree: true,
    terminalHiddenViewParking: true,
    terminalMainSideEffectAuthority: true,
    terminalHiddenDeliveryGate: true,
    terminalModelQueryAuthority: true,
    defaultTuiAgent: null,
    disabledTuiAgents: [...DEFAULT_DISABLED_TUI_AGENTS],
    claudeAgentTeamsDefaultDisabledMigrated: true,
    skipDeleteWorktreeConfirm: false,
    skipCloseTerminalWithRunningProcessConfirm: false,
    skipDeleteAutomationConfirm: false,
    skipCodexRateLimitResetConfirm: false,
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    visibleTaskProviders: [...TASK_PROVIDERS],
    visibleTaskProvidersDefaultedForJira: true,
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    minimaxGroupId: '',
    minimaxUsageModels: 'general',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    agentDefaultArgs: { ...DEFAULT_TUI_AGENT_ARGS },
    agentDefaultEnv: { ...DEFAULT_TUI_AGENT_ENV },
    agentYoloDefaultsMigrated: true,
    agentStatusHooksEnabled: true,
    tabAutoGenerateTitle: false,
    confirmClosePinnedTab: true,
    keepComputerAwakeWhileAgentsRun: false,
    // Why: 'auto' runs a layout-aware probe at boot (see
    // src/renderer/src/lib/keyboard-layout/*) that picks 'true' for US and
    // US-International and 'false' for every other layout. This mirrors
    // Ghostty's detectOptionAsAlt() and ensures users on Turkish, German,
    // French, etc. can type Option+Q/L/E characters like @, €, [, ] out of
    // the box (issue #903) while US users keep Option-as-Alt readline chords.
    terminalMacOptionAsAlt: 'auto',
    terminalMacOptionAsAltMigrated: false,
    terminalJISYenToBackslash: false,
    experimentalMobile: false,
    mobileEmulatorEnabled: true,
    mobileEmulatorDefaultDeviceUdid: null,
    androidSdkPath: null,
    // Why: indefinite hold by default — the desktop "Restore" banner is the
    // explicit return-to-desktop-size action, no wall-clock guess.
    // See docs/mobile-fit-hold.md.
    mobileAutoRestoreFitMs: null,
    // Why: off by default — opt-in cosmetic joke feature. Leaving the default
    // false keeps the overlay unmounted for users who never enable it.
    experimentalPet: false,
    experimentalActivity: false,
    experimentalActivityDefaultedOffForAllUsers: true,
    experimentalTerminalAttention: false,
    experimentalAgentHibernation: false,
    agentHibernationIdleMs: 30 * 60 * 1000,
    experimentalNewWorktreeCardStyle: false,
    experimentalEphemeralVms: false,
    compactWorktreeCards: false,
    experimentalWorktreeSymlinks: false,
    // Why: local desktop remains the default server until the user explicitly
    // selects a saved runtime environment.
    activeRuntimeEnvironmentId: null,
    // Why: hydrate an empty default so the renderer's optional-chained reads
    // (`settings?.githubProjects?.activeProject`) land on a stable shape
    // instead of `undefined`. Upgraded profiles inherit this via the
    // `{ ...defaults, ...parsed }` merge in persistence.ts.
    githubProjects: {
      pinned: [],
      recent: [],
      lastViewByProject: {},
      activeProject: null
    },
    // Why: default-on uses the user's default agent when it supports
    // non-interactive commit-message generation. Keep agent/model maps empty
    // so first use follows the default agent's configured default model instead
    // of freezing a stale choice into new profiles.
    commitMessageAi: {
      enabled: true,
      agentId: null,
      selectedModelByAgent: {},
      discoveredModelsByAgent: {},
      selectedModelByAgentByHost: {},
      discoveredModelsByAgentByHost: {},
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    },
    sourceControlAi: getDefaultSourceControlAiSettings(),
    voice: getDefaultVoiceSettings()
  }
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
    openAiApiKeyConfigured: false
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
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    settings: getDefaultSettings(homedir),
    ui: getDefaultUIState(),
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession(),
    workspaceSessionsByHostId: {},
    sshTargets: [],
    deletedSshConfigAliases: [],
    sshRemotePtyLeases: [],
    claudeLivePtySessionIds: [],
    migrationUnsupportedPtyEntries: [],
    legacyPaneKeyAliasEntries: [],
    automations: [],
    automationRuns: [],
    onboarding: getDefaultOnboardingState(),
    featureInteractionTelemetryBuckets: {}
  }
}

export function getDefaultUIState(): PersistedUIState {
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    sidebarWidth: 280,
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    rightSidebarWidth: 350,
    markdownTocPanelWidth: 240,
    groupBy: 'repo',
    sortBy: 'recent',
    projectOrderBy: 'manual',
    showActiveOnly: false,
    hideSleepingWorkspaces: DEFAULT_HIDE_SLEEPING_WORKSPACES,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    workspaceHostOrder: [],
    showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
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
    mobileEmulatorTabIntroDismissed: false,
    mobileEmulatorAgentSetupDismissed: false,
    // Why: brand-new profiles never saw recent project ordering; only upgraded
    // profiles get the one-time sidebar notice on first launch.
    projectOrderManualDefaultNoticeDismissed: true,
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
