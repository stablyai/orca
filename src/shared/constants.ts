import type {
  GlobalSettings,
  NotificationSettings,
  OnboardingChecklistState,
  OnboardingState,
  PersistedState,
  PersistedUIState,
  RepoHookSettings,
  StatusBarItem,
  WorkspaceSessionState,
  WorktreeCardProperty
} from './types'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from './terminal-fonts'
import { getDefaultTerminalQuickCommands } from './terminal-quick-commands'
import type { VoiceSettings } from './speech-types'
import { cloneDefaultWorkspaceStatuses } from './workspace-statuses'

export const SCHEMA_VERSION = 1
export const DEFAULT_APP_FONT_FAMILY = 'Geist'

// Why: the onboarding wizard's last step index. Centralized so backfill,
// clamps, and UI step references all agree on the same upper bound.
export const ONBOARDING_FINAL_STEP = 4

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

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  'status',
  'unread',
  'ci',
  'issue',
  'pr',
  'comment',
  // Why: agent activity is the primary reason users opt into the feature, so
  // show it inline on each card by default. Unchecking this from the
  // Workspaces view options hides the inline list entirely — there is no
  // alternative agent-activity surface in the sidebar.
  'inline-agents'
]

export const DEFAULT_STATUS_BAR_ITEMS: StatusBarItem[] = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'ssh',
  'resource-usage'
]

/** Synthetic worktree id used by the memory collector to bucket PTYs that
 *  are not associated with any worktree. Shared across main and renderer so
 *  the collector and the status-bar popover agree on the sentinel. */
export const ORPHAN_WORKTREE_ID = '__orphan__'

// Why: the floating terminal is a local synthetic workspace, so persistence
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

export function getDefaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: false,
    suppressWhenFocused: true,
    customSoundPath: null
  }
}

export function getDefaultOnboardingState(): OnboardingState {
  return {
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

export function getDefaultSettings(homedir: string): GlobalSettings {
  return {
    workspaceDir: `${homedir}/orca/workspaces`,
    nestWorkspaces: true,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'git-username',
    branchPrefixCustom: '',
    enableGitHubAttribution: false,
    theme: 'system',
    appFontFamily: DEFAULT_APP_FONT_FAMILY,
    editorAutoSave: false,
    editorAutoSaveDelayMs: DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
    editorMinimapEnabled: false,
    terminalFontSize: 14,
    terminalFontFamily: defaultTerminalFontFamily(),
    terminalFontWeight: DEFAULT_TERMINAL_FONT_WEIGHT,
    terminalLineHeight: 1,
    // Why: VS Code defaults terminal GPU acceleration to "auto": prefer
    // xterm WebGL for performance, but allow renderer failure to choose DOM.
    terminalGpuAcceleration: 'auto',
    // Why 'auto': when the user has picked a known ligature font we want the
    // feature enabled by default, but we never force it if they pick a font
    // that lacks ligatures or if they've explicitly opted out. The resolver
    // is in shared/terminal-ligatures.ts.
    terminalLigatures: 'auto',
    terminalCursorStyle: 'bar',
    terminalCursorBlink: true,
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalDividerColorDark: '#3f3f46',
    terminalUseSeparateLightTheme: false,
    terminalThemeLight: 'Builtin Tango Light',
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
    terminalClipboardOnSelect: false,
    terminalAllowOsc52Clipboard: false,
    setupScriptLaunchMode: 'new-tab',
    terminalScrollbackBytes: 10_000_000,
    openLinksInApp: true,
    rightSidebarOpenByDefault: true,
    showTitlebarAppName: true,
    showTasksButton: true,
    floatingTerminalEnabled: true,
    floatingTerminalDefaultedForAllUsers: true,
    floatingTerminalCwd: '~',
    floatingTerminalTriggerLocation: 'floating-button',
    notifications: getDefaultNotificationSettings(),
    diffDefaultView: 'inline',
    promptCacheTimerEnabled: false,
    promptCacheTtlMs: 300_000,
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    terminalScopeHistoryByWorktree: true,
    defaultTuiAgent: null,
    skipDeleteWorktreeConfirm: false,
    skipDeleteAutomationConfirm: false,
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    keepComputerAwakeWhileAgentsRun: false,
    // Why: 'auto' runs a layout-aware probe at boot (see
    // src/renderer/src/lib/keyboard-layout/*) that picks 'true' for US and
    // US-International and 'false' for every other layout. This mirrors
    // Ghostty's detectOptionAsAlt() and ensures users on Turkish, German,
    // French, etc. can type Option+Q/L/E characters like @, €, [, ] out of
    // the box (issue #903) while US users keep Option-as-Alt readline chords.
    terminalMacOptionAsAlt: 'auto',
    terminalMacOptionAsAltMigrated: false,
    experimentalMobile: false,
    // Why: indefinite hold by default — the desktop "Restore" banner is the
    // explicit return-to-desktop-size action, no wall-clock guess.
    // See docs/mobile-fit-hold.md.
    mobileAutoRestoreFitMs: null,
    // Why: off by default — opt-in cosmetic joke feature. Leaving the default
    // false keeps the overlay unmounted for users who never enable it.
    experimentalPet: false,
    experimentalActivity: true,
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
    // Why: opt-in feature — `enabled: false` keeps the Generate button hidden
    // for existing users until they discover and turn it on in Settings. The
    // per-agent / per-model maps stay empty until the user activates the
    // toggle, at which point the pane fills them with the spec defaults.
    commitMessageAi: {
      enabled: false,
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    },
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
    userModels: []
  }
}

export function getDefaultRepoHookSettings(): RepoHookSettings {
  return {
    mode: 'auto',
    setupRunPolicy: 'run-by-default',
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
    sparsePresetsByRepo: {},
    worktreeMeta: {},
    settings: getDefaultSettings(homedir),
    ui: getDefaultUIState(),
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession(),
    sshTargets: [],
    sshRemotePtyLeases: [],
    automations: [],
    automationRuns: [],
    onboarding: getDefaultOnboardingState()
  }
}

export function getDefaultUIState(): PersistedUIState {
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    sidebarWidth: 280,
    rightSidebarWidth: 350,
    groupBy: 'repo',
    sortBy: 'recent',
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    filterRepoIds: [],
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    workspaceBoardOpacity: 1,
    workspaceBoardCompact: false,
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    statusBarVisible: true,
    dismissedUpdateVersion: null,
    lastUpdateCheckAt: null,
    trustedOrcaHooks: {},
    acknowledgedAgentsByPaneKey: {}
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
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserUrlHistory: []
  }
}
