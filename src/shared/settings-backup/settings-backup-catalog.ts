import type { GlobalSettings } from '../global-settings-types'

/** User-selectable groups of settings that a backup file can carry. */
export const SETTINGS_BACKUP_SECTIONS = [
  'appearance',
  'terminal',
  'editor',
  'git',
  'agents',
  'browser',
  'notifications',
  'general',
  'experimental',
  'device'
] as const

export type SettingsBackupSectionId = (typeof SETTINGS_BACKUP_SECTIONS)[number]

/**
 * `protected`: credentials, account identities and capability/consent grants — never written to a backup
 * and never accepted from one, so a file can neither leak a secret nor grant a permission.
 * `internal`: migration guards, kill switches, local ids and dismissals that only mean something on the
 * machine that wrote them.
 */
export type SettingsBackupKeyClass = SettingsBackupSectionId | 'protected' | 'internal'

/** Sections exported when the user does not choose; `device` is opt-in because it holds paths and shells. */
export const DEFAULT_SETTINGS_BACKUP_SECTIONS: readonly SettingsBackupSectionId[] =
  SETTINGS_BACKUP_SECTIONS.filter((section) => section !== 'device')

// Why: exhaustive over GlobalSettings so a new setting fails typecheck until someone decides whether it
// may leave the machine, instead of silently riding along in backups.
export const SETTINGS_BACKUP_KEY_CLASSES = {
  // Appearance
  theme: 'appearance',
  leftSidebarAppearanceMode: 'appearance',
  leftSidebarTintColor: 'appearance',
  leftSidebarTintOpacity: 'appearance',
  uiLanguage: 'appearance',
  appIcon: 'appearance',
  appFontFamily: 'appearance',
  windowBackgroundBlur: 'appearance',
  showTitlebarAppName: 'appearance',
  showTasksButton: 'appearance',
  showAutomationsButton: 'appearance',
  showArtifactsButton: 'appearance',
  showSkillsButton: 'appearance',
  showMobileButton: 'appearance',
  showPinnedWorktreesInGroups: 'appearance',
  compactWorktreeCards: 'appearance',
  nativeChatAppearance: 'appearance',
  floatingTerminalTriggerLocation: 'appearance',

  // Terminal
  terminalFontSize: 'terminal',
  terminalFontFamily: 'terminal',
  terminalFontWeight: 'terminal',
  terminalFontWeightBold: 'terminal',
  terminalLineHeight: 'terminal',
  terminalScrollSensitivity: 'terminal',
  terminalFastScrollSensitivity: 'terminal',
  terminalTuiScrollSensitivity: 'terminal',
  terminalGpuAcceleration: 'terminal',
  terminalLigatures: 'terminal',
  terminalInlineImages: 'terminal',
  terminalCursorStyle: 'terminal',
  terminalCursorBlink: 'terminal',
  terminalThemeDark: 'terminal',
  terminalCustomThemes: 'terminal',
  terminalDividerColorDark: 'terminal',
  terminalUseSeparateLightTheme: 'terminal',
  terminalThemeLight: 'terminal',
  terminalDividerColorLight: 'terminal',
  terminalInactivePaneOpacity: 'terminal',
  terminalActivePaneOpacity: 'terminal',
  terminalPaneOpacityTransitionMs: 'terminal',
  terminalDividerThicknessPx: 'terminal',
  terminalBackgroundOpacity: 'terminal',
  terminalMinimumContrastRatio: 'terminal',
  terminalColorOverrides: 'terminal',
  terminalPaddingX: 'terminal',
  terminalPaddingY: 'terminal',
  terminalMouseHideWhileTyping: 'terminal',
  terminalWordSeparator: 'terminal',
  terminalCursorOpacity: 'terminal',
  terminalQuickCommands: 'terminal',
  terminalRightClickToPaste: 'terminal',
  terminalFocusFollowsMouse: 'terminal',
  terminalClipboardOnSelect: 'terminal',
  terminalCopyTrimsGutter: 'terminal',
  terminalAllowOsc52Clipboard: 'terminal',
  terminalScrollbackRows: 'terminal',
  terminalScopeHistoryByWorktree: 'terminal',
  terminalLinkActionPopoverEnabled: 'terminal',
  terminalLinkClickBehavior: 'terminal',
  terminalUrlMiddleClickBehavior: 'terminal',
  terminalMacOptionAsAlt: 'terminal',
  terminalJISYenToBackslash: 'terminal',
  terminalShortcutPolicy: 'terminal',
  ctrlTabOrderMode: 'terminal',
  primarySelectionMiddleClickPaste: 'terminal',
  setupScriptLaunchMode: 'terminal',

  // Editor and files
  editorAutoSave: 'editor',
  editorAutoSaveDelayMs: 'editor',
  editorMinimapEnabled: 'editor',
  editorFontFamily: 'editor',
  editorWordWrap: 'editor',
  editorPreviewTabsEnabled: 'editor',
  richMarkdownSpellcheckEnabled: 'editor',
  markdownReviewToolsEnabled: 'editor',
  followSymlinkedDirectories: 'editor',
  showGitIgnoredFiles: 'editor',
  tabAutoGenerateTitle: 'editor',
  confirmClosePinnedTab: 'editor',

  // Git and source control
  nestWorkspaces: 'git',
  worktreeVisibilityDefaults: 'git',
  refreshLocalBaseRefOnWorktreeCreate: 'git',
  autoRenameBranchFromWork: 'git',
  branchPrefix: 'git',
  branchPrefixCustom: 'git',
  sourceControlViewMode: 'git',
  sourceControlGroupOrder: 'git',
  sourceControlCompareAgainstUpstream: 'git',
  diffDefaultView: 'git',
  diffWordWrap: 'git',
  diffShowWhitespace: 'git',
  diffCollapseUnchangedRegions: 'git',
  combinedDiffFileTreeVisibleByDefault: 'git',
  prBotAuthorOverrides: 'git',

  // Agents and AI
  defaultTuiAgent: 'agents',
  disabledTuiAgents: 'agents',
  agentDefaultArgs: 'agents',
  agentStatusHooksEnabled: 'agents',
  agentWorkspaceTrustEnabled: 'agents',
  agentStateRulesLiveUpdates: 'agents',
  codexTerminalServerIsolation: 'agents',
  codexSharedServerWarning: 'agents',
  claudeAgentTeamsMode: 'agents',
  promptCacheTimerEnabled: 'agents',
  promptCacheTtlMs: 'agents',
  experimentalNativeChat: 'agents',
  nativeChatAutoName: 'agents',
  nativeChatResumeWorkOnRestart: 'agents',
  nativeChatQueueFollowUps: 'agents',
  nativeChatInlineVisuals: 'agents',
  nativeChatInheritShellEnvironment: 'agents',
  nativeChatShellEnvironmentVariables: 'agents',
  nativeChatSessionOptions: 'agents',
  commitMessageAi: 'agents',
  sourceControlAi: 'agents',
  minimaxUsageModels: 'agents',
  minimaxEndpoint: 'agents',
  zcodePlanSite: 'agents',

  // Browser
  openLinksInApp: 'browser',
  openLinksInAppModifierInverts: 'browser',
  localhostWorktreeLabelsEnabled: 'browser',
  browserClientHostedRemoteEnabled: 'browser',
  browserSshWorkspaceRoutingEnabled: 'browser',

  // Notifications
  notifications: 'notifications',

  // General behavior
  keepComputerAwakeWhileAgentsRun: 'general',
  computerAwakeMode: 'general',
  floatingTerminalEnabled: 'general',
  skipDeleteWorktreeConfirm: 'general',
  alwaysForceDeleteWorktrees: 'general',
  skipCloseTerminalWithRunningProcessConfirm: 'general',
  skipDeleteAutomationConfirm: 'general',
  skipDeleteArtifactConfirm: 'general',
  skipCodexRateLimitResetConfirm: 'general',
  defaultTaskViewPreset: 'general',
  defaultTaskSource: 'general',
  visibleTaskProviders: 'general',
  githubProjects: 'general',
  gitlabProjects: 'general',
  mobileAutoRestoreFitMs: 'general',
  mobilePairingConnectionMode: 'general',

  // Experimental
  experimentalPet: 'experimental',
  experimentalActivity: 'experimental',
  experimentalAgentDashboardPopout: 'experimental',
  experimentalAgentDashboardMode: 'experimental',
  experimentalAgentDashboardShowIdle: 'experimental',
  experimentalTerminalAttention: 'experimental',
  experimentalAgentHibernation: 'experimental',
  agentHibernationIdleMs: 'experimental',
  experimentalNewWorktreeCardStyle: 'experimental',
  experimentalEphemeralVms: 'experimental',
  experimentalMobile: 'experimental',
  pluginSystemEnabled: 'experimental',

  // Device-specific: paths, shells, runtimes and hardware that rarely carry over between machines
  workspaceDir: 'device',
  floatingTerminalCwd: 'device',
  terminalWindowsShell: 'device',
  terminalWindowsPowerShellImplementation: 'device',
  terminalDefaultShell: 'device',
  terminalDefaultShellArgs: 'device',
  terminalWindowsWslDistro: 'device',
  localAccountRuntime: 'device',
  localAccountWslDistro: 'device',
  localAgentRuntime: 'device',
  localAgentWslDistro: 'device',
  localWindowsRuntimeDefault: 'device',
  minimizeToTrayOnClose: 'device',
  showMenuBarIcon: 'device',
  openInApplications: 'device',
  agentCmdOverrides: 'device',
  codexSessionSourceHome: 'device',
  agentStateRulesPath: 'device',
  androidSdkPath: 'device',
  mobileEmulatorEnabled: 'device',
  mobileEmulatorDefaultDeviceUdid: 'device',
  mobilePairingCustomAddress: 'device',
  mobilePairingCustomAddresses: 'device',
  httpProxyBypassRules: 'device',
  electronHttp1CompatibilityMode: 'device',
  voice: 'device',

  // Protected: secrets, accounts and grants that each machine must set up itself
  httpProxyUrl: 'protected',
  opencodeSessionCookie: 'protected',
  opencodeWorkspaceId: 'protected',
  minimaxGroupId: 'protected',
  geminiCliOAuthEnabled: 'protected',
  agentDefaultEnv: 'protected',
  codexManagedAccounts: 'protected',
  activeCodexManagedAccountId: 'protected',
  activeCodexManagedAccountIdsByRuntime: 'protected',
  claudeManagedAccounts: 'protected',
  activeClaudeManagedAccountId: 'protected',
  activeClaudeManagedAccountIdsByRuntime: 'protected',
  pluginConsents: 'protected',
  disabledPlugins: 'protected',
  floatingTerminalTrustedCwds: 'protected',
  artifactSharingEnabled: 'protected',
  agentSkillSharingEnabled: 'protected',
  nestedWorkerMaxDepth: 'protected',
  aiVaultSearch: 'protected',
  telemetry: 'protected',

  // Internal: one-shot migration guards, kill switches, local ids and dismissed prompts
  machineName: 'internal',
  hostSettingOverrides: 'internal',
  workspaceDirHistory: 'internal',
  devPluginPaths: 'internal',
  activeRuntimeEnvironmentId: 'internal',
  defaultRepoSelection: 'internal',
  defaultLinearTeamSelection: 'internal',
  browserSshWorkspaceRoutingDisabledTargetIds: 'internal',
  browserSshWorkspaceRoutingProbeSkippedTargetIds: 'internal',
  keybindings: 'internal',
  rightSidebarOpenByDefault: 'internal',
  artifactsEnabled: 'internal',
  experimentalCompactWorktreeCards: 'internal',
  experimentalSidekick: 'internal',
  terminalHiddenViewParking: 'internal',
  terminalSshViewParking: 'internal',
  terminalHiddenWorktreeRetentionBudget: 'internal',
  browserGuestWorktreeRetentionBudget: 'internal',
  terminalMainSideEffectAuthority: 'internal',
  terminalHiddenDeliveryGate: 'internal',
  terminalModelQueryAuthority: 'internal',
  localBaseRefSuggestionDismissed: 'internal',
  openLinksInAppPreferencePrompted: 'internal',
  agentsSidebarIntroShown: 'internal',
  agentsSidebarMigratedFromExperimental: 'internal',
  dismissedSkillFreshnessNudges: 'internal',
  tabSwitchKeybindingSeed: 'internal',
  autoRenameBranchFromWorkDefaultedOn: 'internal',
  primarySelectionMiddleClickPasteDefaultedForLinux: 'internal',
  primarySelectionMiddleClickPasteDefaultedForTerminalDefaults: 'internal',
  terminalTuiScrollSensitivityDefaultedToOne: 'internal',
  terminalCursorStyleDefaultedToBlock: 'internal',
  terminalRightClickToPasteDefaultedForPlatform: 'internal',
  localAccountRuntimeDefaultedToAutoForAllUsers: 'internal',
  terminalAllowOsc52ClipboardDefaultedOnForAllUsers: 'internal',
  floatingTerminalDefaultedForAllUsers: 'internal',
  floatingTerminalCwdMigratedToAppWorkspace: 'internal',
  claudeAgentTeamsDefaultDisabledMigrated: 'internal',
  visibleTaskProvidersDefaultedForJira: 'internal',
  agentYoloDefaultsMigrated: 'internal',
  terminalMacOptionAsAltMigrated: 'internal',
  experimentalActivityDefaultedOffForAllUsers: 'internal'
} as const satisfies Record<keyof GlobalSettings, SettingsBackupKeyClass>

/** Nested fields that only make sense on the machine that wrote them; kept local on import. */
export const SETTINGS_BACKUP_DEVICE_BOUND_NESTED_FIELDS: Partial<
  Record<keyof GlobalSettings, readonly string[]>
> = {
  notifications: ['customSoundPath', 'mutedNotificationSourceIds']
}

const KEY_CLASS_LOOKUP: ReadonlyMap<string, SettingsBackupKeyClass> = new Map(
  Object.entries(SETTINGS_BACKUP_KEY_CLASSES)
)

export function getSettingsBackupKeyClass(key: string): SettingsBackupKeyClass | null {
  return KEY_CLASS_LOOKUP.get(key) ?? null
}

export function isSettingsBackupSectionId(value: unknown): value is SettingsBackupSectionId {
  return typeof value === 'string' && SETTINGS_BACKUP_SECTIONS.some((section) => section === value)
}

export function listSettingsBackupKeys(
  sections: readonly SettingsBackupSectionId[]
): (keyof GlobalSettings)[] {
  const wanted = new Set<string>(sections)
  const keys: (keyof GlobalSettings)[] = []
  for (const [key, keyClass] of Object.entries(SETTINGS_BACKUP_KEY_CLASSES)) {
    if (wanted.has(keyClass) && isGlobalSettingsKey(key)) {
      keys.push(key)
    }
  }
  return keys
}

function isGlobalSettingsKey(key: string): key is keyof GlobalSettings {
  return KEY_CLASS_LOOKUP.has(key)
}
