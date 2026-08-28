import type { GlobalSettings } from './global-settings-types'
import type { NotificationSettings } from './notification-settings-types'
import type { VoiceSettings } from './speech-types'
import { DEFAULT_TERMINAL_FONT_WEIGHT, DEFAULT_TERMINAL_FONT_WEIGHT_BOLD } from './terminal-fonts'
import { getDefaultTerminalQuickCommands } from './terminal-quick-commands'
import { TASK_PROVIDERS } from './task-providers'
import { getDefaultSourceControlAiSettings } from './source-control-ai'
import { DEFAULT_APP_ICON_ID } from './app-icon'
import { DEFAULT_OPEN_IN_APPLICATIONS } from './open-in-applications'
import { DEFAULT_DISABLED_TUI_AGENTS } from './tui-agent-selection'
import { DEFAULT_TUI_AGENT_ARGS, DEFAULT_TUI_AGENT_ENV } from './tui-agent-launch-defaults'
import { UI_LANGUAGE_SYSTEM } from './ui-language'
import {
  DEFAULT_LEFT_SIDEBAR_TINT_COLOR,
  DEFAULT_LEFT_SIDEBAR_TINT_OPACITY
} from './left-sidebar-appearance'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from './source-control-group-order'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from './terminal-scrollback-policy'

export function buildDefaultSettings(args: {
  workspaceDir: string
  appFontFamily: string
  editorAutoSaveDelayMs: number
  primarySelectionMiddleClickPaste: boolean
  primarySelectionDefaultedForLinux: boolean
  terminalFontFamily: string
  terminalInactivePaneOpacity: number
  terminalRightClickToPaste: boolean
  notifications: NotificationSettings
  voice: VoiceSettings
}): GlobalSettings {
  return {
    workspaceDir: args.workspaceDir,
    worktreeVisibilityDefaults: { external: 'hide' },
    nestWorkspaces: true,
    workspaceDirHistory: [],
    refreshLocalBaseRefOnWorktreeCreate: false,
    localBaseRefSuggestionDismissed: false,
    autoRenameBranchFromWork: true,
    autoRenameBranchFromWorkDefaultedOn: true,
    branchPrefix: 'git-username',
    branchPrefixCustom: '',
    theme: 'system',
    leftSidebarAppearanceMode: 'default',
    leftSidebarTintColor: DEFAULT_LEFT_SIDEBAR_TINT_COLOR,
    leftSidebarTintOpacity: DEFAULT_LEFT_SIDEBAR_TINT_OPACITY,
    uiLanguage: UI_LANGUAGE_SYSTEM,
    appIcon: DEFAULT_APP_ICON_ID,
    appFontFamily: args.appFontFamily,
    editorAutoSave: false,
    editorAutoSaveDelayMs: args.editorAutoSaveDelayMs,
    editorMinimapEnabled: false,
    // Why empty: the editor keeps following the terminal font unless the user opts in.
    editorFontFamily: '',
    editorWordWrap: true,
    richMarkdownSpellcheckEnabled: true,
    markdownReviewToolsEnabled: true,
    primarySelectionMiddleClickPaste: args.primarySelectionMiddleClickPaste,
    primarySelectionMiddleClickPasteDefaultedForLinux: args.primarySelectionDefaultedForLinux,
    primarySelectionMiddleClickPasteDefaultedForTerminalDefaults:
      args.primarySelectionMiddleClickPaste,
    terminalFontSize: 14,
    terminalFontFamily: args.terminalFontFamily,
    terminalFontWeight: DEFAULT_TERMINAL_FONT_WEIGHT,
    terminalFontWeightBold: DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
    terminalLineHeight: 1,
    terminalScrollSensitivity: 1.15,
    terminalFastScrollSensitivity: 5,
    terminalTuiScrollSensitivity: 1,
    terminalTuiScrollSensitivityDefaultedToOne: true,
    // Why: "auto" uses WebGL when supported, falling back to DOM on renderer failure or software/unknown GPU.
    terminalGpuAcceleration: 'auto',
    // Why 'auto': enable ligatures only for known ligature fonts, never forced. Resolver in shared/terminal-ligatures.ts.
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
    terminalInactivePaneOpacity: args.terminalInactivePaneOpacity,
    terminalActivePaneOpacity: 1,
    terminalPaneOpacityTransitionMs: 140,
    terminalDividerThicknessPx: 3,
    // Why: Windows paste-on-right-click matches native convention; macOS/Linux keep right-click for the context menu.
    terminalRightClickToPaste: args.terminalRightClickToPaste,
    terminalRightClickToPasteDefaultedForPlatform: true,
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsWslDistro: null,
    localAccountRuntime: 'auto',
    localAccountRuntimeDefaultedToAutoForAllUsers: true,
    localAccountWslDistro: null,
    localWindowsRuntimeDefault: { kind: 'windows-host' },
    // Why: prefer modern PowerShell when installed, falling back to inbox Windows PowerShell.
    terminalWindowsPowerShellImplementation: 'auto',
    terminalMouseHideWhileTyping: false,
    terminalQuickCommands: getDefaultTerminalQuickCommands(),
    // Why: opt-in only, matching Ghostty's default (upgrades never enable it unexpectedly).
    terminalFocusFollowsMouse: false,
    windowBackgroundBlur: false,
    minimizeToTrayOnClose: false,
    // Why: default-on everywhere so it round-trips across platforms; only darwin acts on it.
    showMenuBarIcon: true,
    terminalClipboardOnSelect: false,
    // Why: default on so Zellij/tmux/nvim copy works out of the box. Query
    // replies stay disabled and payload size is capped in the OSC 52 handler.
    // This default only covers new profiles; existing ones persisted `false`
    // and are flipped once by the stamp below (shared/osc52-clipboard-settings.ts,
    // applied by both the Electron store and the web client's localStorage store).
    terminalAllowOsc52Clipboard: true,
    terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true,
    claudeAgentTeamsMode: 'off',
    setupScriptLaunchMode: 'new-tab',
    terminalScrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    httpProxyUrl: '',
    httpProxyBypassRules: '',
    electronHttp1CompatibilityMode: false,
    openLinksInApp: false,
    localhostWorktreeLabelsEnabled: false,
    openLinksInAppPreferencePrompted: false,
    openLinksInAppModifierInverts: false,
    terminalLinkActionPopoverEnabled: true,
    openAgentTabsInChatByDefault: false,
    experimentalNativeChat: false,
    nativeChatSessionOptions: {},
    openInApplications: [...DEFAULT_OPEN_IN_APPLICATIONS],
    rightSidebarOpenByDefault: true,
    showGitIgnoredFiles: true,
    sourceControlViewMode: 'list',
    sourceControlGroupOrder: DEFAULT_SOURCE_CONTROL_GROUP_ORDER,
    sourceControlCompareAgainstUpstream: false,
    showTitlebarAppName: true,
    showTasksButton: true,
    showAutomationsButton: true,
    artifactsEnabled: true,
    artifactSharingEnabled: false,
    agentSkillSharingEnabled: false,
    nestedWorkerMaxDepth: 1,
    showArtifactsButton: false,
    showSkillsButton: false,
    showMobileButton: true,
    showPinnedWorktreesInGroups: false,
    ctrlTabOrderMode: 'mru',
    // Why: Orca-first keeps core shortcuts working from a focused terminal; TUI-ownership users opt in.
    terminalShortcutPolicy: 'orca-first',
    floatingTerminalEnabled: true,
    browserClientHostedRemoteEnabled: true,
    floatingTerminalDefaultedForAllUsers: true,
    floatingTerminalCwd: '~',
    floatingTerminalTrustedCwds: [],
    floatingTerminalCwdMigratedToAppWorkspace: true,
    floatingTerminalTriggerLocation: 'floating-button',
    notifications: args.notifications,
    diffDefaultView: 'inline',
    diffWordWrap: false,
    combinedDiffFileTreeVisibleByDefault: false,
    prBotAuthorOverrides: [],
    promptCacheTimerEnabled: false,
    promptCacheTtlMs: 300_000,
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} },
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    terminalScopeHistoryByWorktree: true,
    terminalHiddenViewParking: true,
    // C1 kill switches — runtime reads stay `!== false` so older persisted
    // settings objects (which omit them) keep the default-on behavior.
    terminalSshViewParking: true,
    terminalHiddenWorktreeRetentionBudget: true,
    browserGuestWorktreeRetentionBudget: true,
    terminalMainSideEffectAuthority: true,
    terminalHiddenDeliveryGate: true,
    terminalModelQueryAuthority: true,
    defaultTuiAgent: null,
    disabledTuiAgents: [...DEFAULT_DISABLED_TUI_AGENTS],
    pluginSystemEnabled: false,
    disabledPlugins: [],
    pluginConsents: {},
    devPluginPaths: [],
    claudeAgentTeamsDefaultDisabledMigrated: true,
    skipDeleteWorktreeConfirm: false,
    skipCloseTerminalWithRunningProcessConfirm: false,
    skipDeleteAutomationConfirm: false,
    skipDeleteArtifactConfirm: false,
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
    // Why: 'auto' probes keyboard layout so non-US users can type Option chars like @/€/[ out of the box (issue #903). See src/renderer/src/lib/keyboard-layout/*.
    terminalMacOptionAsAlt: 'auto',
    terminalMacOptionAsAltMigrated: false,
    terminalJISYenToBackslash: false,
    experimentalMobile: false,
    mobileEmulatorEnabled: true,
    mobileEmulatorDefaultDeviceUdid: null,
    androidSdkPath: null,
    // Why: indefinite hold — the "Restore" banner is the explicit return action, no wall-clock guess. See docs/mobile-fit-hold.md.
    mobileAutoRestoreFitMs: null,
    // Why: Anywhere (Relay + local) is the default; local-only is written only on explicit same-network choice.
    mobilePairingConnectionMode: 'automatic',
    mobilePairingCustomAddress: null,
    mobilePairingCustomAddresses: [],
    // Why: off keeps the cosmetic overlay unmounted for users who never opt in.
    experimentalPet: false,
    experimentalActivity: false,
    experimentalActivityDefaultedOffForAllUsers: true,
    experimentalTerminalAttention: false,
    experimentalAgentHibernation: false,
    agentHibernationIdleMs: 30 * 60 * 1000,
    experimentalNewWorktreeCardStyle: false,
    experimentalEphemeralVms: false,
    compactWorktreeCards: false,
    // Why: local desktop stays the default until the user picks a saved runtime environment.
    activeRuntimeEnvironmentId: null,
    // Why: hydrate a stable empty shape so renderer optional-chained reads never hit undefined.
    githubProjects: {
      pinned: [],
      recent: [],
      lastViewByProject: {},
      activeProject: null
    },
    // Why: keep agent/model maps empty so first use follows the default agent's model, not a frozen stale choice.
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
    voice: args.voice
  }
}
