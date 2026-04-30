import type {
  GlobalSettings,
  NotificationSettings,
  PersistedState,
  PersistedUIState,
  RepoHookSettings,
  StatusBarItem,
  WorkspaceSessionState,
  WorktreeCardProperty
} from './types'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from './terminal-fonts'

export const SCHEMA_VERSION = 1

export const ORCA_BROWSER_PARTITION = 'persist:orca-browser'
// Why: blank browser tabs must start from an inert guest URL that does not
// navigate the privileged main window to about:blank. Renderer and main both
// need the exact same value so the attach policy can allow only this one safe
// data URL while still rejecting arbitrary renderer-provided data URLs.
export const ORCA_BROWSER_BLANK_URL = 'data:text/html,'

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
// without starring — e.g. 50 → 100 → 200 → 400. Past dismissals are encoded
// in starNagNextThreshold, so this constant is only the first-time seed.
export const STAR_NAG_INITIAL_THRESHOLD = 50

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  'status',
  'unread',
  'ci',
  'issue',
  'pr',
  'comment'
]

export const DEFAULT_STATUS_BAR_ITEMS: StatusBarItem[] = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'ssh',
  'sessions',
  'memory'
]

/** Synthetic worktree id used by the memory collector to bucket PTYs that
 *  are not associated with any worktree. Shared across main and renderer so
 *  the collector and the status-bar popover agree on the sentinel. */
export const ORPHAN_WORKTREE_ID = '__orphan__'

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
    suppressWhenFocused: true
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
    editorAutoSave: false,
    editorAutoSaveDelayMs: DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
    terminalFontSize: 14,
    terminalFontFamily: defaultTerminalFontFamily(),
    terminalFontWeight: DEFAULT_TERMINAL_FONT_WEIGHT,
    terminalLineHeight: 1,
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
    terminalMouseHideWhileTyping: false,
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
    showTitlebarAgentActivity: true,
    showAgentDashboard: true,
    showTaskProviderIcons: true,
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
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    // Why: 'auto' runs a layout-aware probe at boot (see
    // src/renderer/src/lib/keyboard-layout/*) that picks 'true' for US and
    // US-International and 'false' for every other layout. This mirrors
    // Ghostty's detectOptionAsAlt() and ensures users on Turkish, German,
    // French, etc. can type Option+Q/L/E characters like @, €, [, ] out of
    // the box (issue #903) while US users keep Option-as-Alt readline chords.
    terminalMacOptionAsAlt: 'auto',
    terminalMacOptionAsAltMigrated: false,
    // Why: opt-in preview — default off so managed-hook installation
    // (Claude/Codex/Gemini) stays dormant for existing users and upgraders
    // (persistence.ts merges defaults first, so upgraders inherit this).
    experimentalAgentDashboard: false
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
    worktreeMeta: {},
    settings: getDefaultSettings(homedir),
    ui: getDefaultUIState(),
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession(),
    sshTargets: []
  }
}

export function getDefaultUIState(): PersistedUIState {
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    sidebarWidth: 280,
    rightSidebarWidth: 350,
    groupBy: 'none',
    sortBy: 'name',
    showActiveOnly: false,
    filterRepoIds: [],
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    statusBarVisible: true,
    dismissedUpdateVersion: null,
    lastUpdateCheckAt: null,
    trustedOrcaHooks: {}
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
