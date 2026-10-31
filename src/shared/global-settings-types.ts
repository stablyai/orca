import type { AgentLaunchChoices } from './agent-launch-choices'
import type { TelemetrySettings } from './telemetry-settings-types'
import type { BrowserProfileScope } from './browser-profile-scope'
import type { GlobalSettingsBase } from './global-settings-base'
import type { ExecutionHostId } from './execution-host'
import type { OrcaWorkspaceLayout } from './orca-workspace-layout'
import type { GitHubProjectSettings } from './github/project-types'
import type { VoiceSettings } from './speech-types'
import type { AiVaultSearchSettings } from './ai-vault-search-settings'
import type { GitLabProjectSettings } from './gitlab-types'
import type { TaskProvider } from './task-providers'
import type { KeybindingOverrides, TerminalShortcutPolicy } from './keybindings'
import type { AppIconId } from './app-icon'
import type { SourceControlAiSettings } from './source-control-ai-types'
import type { ClaudeAgentTeamsMode } from './claude-agent-teams-tmux-compat'
import type { TerminalCustomTheme } from './terminal-custom-themes'
import type { UiLanguage } from './ui-language'
import type { GlobalWindowsRuntimeDefault } from './project-execution-runtime'
import type { PersistedNativeChatSessionOptions } from './native-chat/input/native-chat-session-options'
import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { ComputerAwakeMode } from './computer-awake-mode'
import type { CommitMessageAiSettings } from './commit-message-ai-types'
import type { HostSettingOverrides } from './host-setting-overrides'
import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountRuntimeSelection,
  CodexManagedAccount,
  CodexManagedAccountRuntimeSelection
} from './managed-account-types'
import type { NotificationSettings } from './notification-settings-types'
import type { CtrlTabOrderMode } from './tab-types'
import type { TerminalColorOverrides } from './terminal-color-overrides'
import type { TerminalQuickCommand } from './terminal-quick-command-types'
import type { TuiAgent } from './tui-agent'
import type { ZcodePlanSite } from './zcode-plan-sites'
import type {
  AgentDashboardMode,
  BranchPrefixStrategy,
  FloatingTerminalTriggerLocation,
  JiraIssueKeyCasing,
  LeftSidebarAppearanceMode,
  OpenInApplication,
  SourceControlGroupOrder,
  SourceControlViewMode,
  TaskViewPresetId
} from './ui-chrome-types'
import type { WorktreeVisibilityDefaults } from './repo-types'

export type { WorktreeVisibilityDefaults } from './repo-types'

/** MiniMax account region used to select the quota endpoint. */
export type MiniMaxEndpoint = 'overseas' | 'cn'

export type GlobalSettings = GlobalSettingsBase & {
  workspaceDir: string
  /** Host-owned defaults used when a repository has no explicit visibility override. */
  worktreeVisibilityDefaults?: WorktreeVisibilityDefaults
  /** Per-host value is host override ?? client default, keyed by ExecutionHostId. */
  hostSettingOverrides?: Partial<Record<ExecutionHostId, HostSettingOverrides>>
  nestWorkspaces: boolean
  workspaceDirHistory?: OrcaWorkspaceLayout[]
  refreshLocalBaseRefOnWorktreeCreate: boolean
  /** Permanently dismisses the suggestion to enable local base refresh. */
  localBaseRefSuggestionDismissed: boolean
  /** Rename generated creature branches from first-prompt work; users can disable this in global Git settings. */
  autoRenameBranchFromWork: boolean
  /** One-shot migration guard for the default-on rollout. Existing profiles
   *  without the guard are flipped on once; later explicit opt-outs stick. */
  autoRenameBranchFromWorkDefaultedOn?: boolean
  branchPrefix: BranchPrefixStrategy
  branchPrefixCustom: string
  /** Jira key casing for newly generated Jira-linked workspace and branch names.
   *  Existing workspaces and user-typed names are never rewritten. */
  jiraIssueKeyCasing?: JiraIssueKeyCasing
  theme: 'system' | 'dark' | 'light'
  /** Controls the left sidebar surface without changing terminal brightness. */
  leftSidebarAppearanceMode: LeftSidebarAppearanceMode
  leftSidebarTintColor?: string
  leftSidebarTintOpacity?: number
  uiLanguage: UiLanguage
  uiLanguagePortugueseMigrationApplied?: boolean
  appIcon: AppIconId
  appFontFamily: string
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  editorMinimapEnabled: boolean
  /** Opt-in code-editor font; empty (the default) keeps following `terminalFontFamily`. */
  editorFontFamily?: string
  /** Defaults on for profiles saved before file-editor wrapping became configurable. */
  editorWordWrap?: boolean
  /** Persisted opt-out for browser spellcheck noise in rich Markdown editing surfaces. */
  richMarkdownSpellcheckEnabled?: boolean
  /** Whether local markdown review note controls and the review panel are shown. */
  markdownReviewToolsEnabled: boolean
  /** Selection paste preserves the normal clipboard; defaults on for Linux/macOS, off for Windows. */
  primarySelectionMiddleClickPaste?: boolean
  /** One-shot migration guard for turning the Linux default on for profiles
   *  that persisted the earlier off-by-default value. */
  primarySelectionMiddleClickPasteDefaultedForLinux?: boolean
  /** One-shot migration guard for widening the terminal-style default to
   *  Linux/macOS while preserving later explicit opt-outs. */
  primarySelectionMiddleClickPasteDefaultedForTerminalDefaults?: boolean
  terminalFontSize: number
  terminalFontFamily: string
  terminalFontWeight: number
  terminalFontWeightBold: number
  terminalLineHeight: number
  terminalScrollSensitivity: number
  terminalFastScrollSensitivity: number
  terminalTuiScrollSensitivity: number
  /** One-shot migration guard for moving inherited TUI wheel reports from 3 to 1. */
  terminalTuiScrollSensitivityDefaultedToOne?: boolean
  /** auto tries WebGL with DOM fallback for risk/unsupported hosts; on always tries WebGL; off uses DOM. */
  terminalGpuAcceleration: 'auto' | 'on' | 'off'
  /** auto enables @xterm/addon-ligatures only for known ligature fonts (Fira Code, JetBrains Mono, Cascadia).
   * Explicit on/off survives font changes. */
  terminalLigatures: 'auto' | 'on' | 'off'
  /** Enable SIXEL/iTerm2/Kitty via lazy @xterm/addon-image; image canvas/storage allocates only after a pane receives an image. */
  terminalInlineImages: boolean
  terminalCursorStyle: 'bar' | 'block' | 'underline'
  /** One-shot migration guard for moving inherited cursor defaults to block. */
  terminalCursorStyleDefaultedToBlock?: boolean
  terminalCursorBlink: boolean
  terminalThemeDark: string
  terminalCustomThemes?: TerminalCustomTheme[]
  terminalDividerColorDark: string
  terminalUseSeparateLightTheme: boolean
  terminalThemeLight: string
  terminalDividerColorLight: string
  terminalInactivePaneOpacity: number
  terminalActivePaneOpacity: number
  terminalPaneOpacityTransitionMs: number
  terminalDividerThicknessPx: number
  terminalBackgroundOpacity?: number
  /** xterm minimumContrastRatio floor for terminal panes (#10754). Undefined keeps the automatic,
   *  background-luminance-gated floor (3 dark / 4.5 light); 1 disables contrast correction so TUIs
   *  that rely on deliberately low contrast (Powerline seams, dimmed secondary text) render as sent. */
  terminalMinimumContrastRatio?: number
  terminalColorOverrides?: TerminalColorOverrides
  terminalPaddingX?: number
  terminalPaddingY?: number
  terminalMouseHideWhileTyping?: boolean
  terminalWordSeparator?: string
  terminalCursorOpacity?: number
  terminalQuickCommands?: TerminalQuickCommand[]
  windowBackgroundBlur?: boolean
  /** Windows-only: close (X) hides to tray instead of quitting; the tray icon is always present regardless. */
  minimizeToTrayOnClose?: boolean
  /** macOS: toggles the additive menu-bar entry (Orca survives last-window close); doesn't change Dock behavior. */
  showMenuBarIcon?: boolean
  /** Windows convention: right-click pastes; macOS/Linux keep the context menu. */
  terminalRightClickToPaste: boolean
  /** One-shot guard distinguishing the old global true default from a per-platform choice. */
  terminalRightClickToPasteDefaultedForPlatform?: boolean
  /** Windows-only: COMSPEC always points to cmd.exe, so this explicit shell (default 'powershell.exe') overrides it. */
  terminalWindowsShell: string
  /** Optional shell executable for new terminals on macOS and Linux. */
  terminalDefaultShell?: string
  /** Optional argv passed to the configured Unix shell for ordinary interactive panes. */
  terminalDefaultShellArgs?: string[]
  /** Pins the WSL distro for terminals/agent scans instead of WSL's current global default. */
  terminalWindowsWslDistro?: string | null
  /** Account/auth location; auto follows the global Windows runtime while host/wsl pin it. */
  localAccountRuntime: 'auto' | 'host' | 'wsl'
  localAccountWslDistro?: string | null
  /** One-shot guard for migrating the legacy host default to auto. */
  localAccountRuntimeDefaultedToAutoForAllUsers?: boolean
  /** Independent from the terminal shell so users can inspect Windows vs WSL agent PATH state without changing it. */
  localAgentRuntime?: 'host' | 'wsl'
  localAgentWslDistro?: string | null
  /** Why: global is only the default policy; project-level runtime preference wins. */
  localWindowsRuntimeDefault: GlobalWindowsRuntimeDefault
  /** 'auto' resolves to PowerShell 7+ when present, else falls back to inbox Windows PowerShell. */
  terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
  terminalFocusFollowsMouse: boolean
  /** X11/gnome-terminal "copy on select": selecting text auto-copies to the clipboard; default off. */
  terminalClipboardOnSelect: boolean
  /** Drops the left gutter agent CLIs paint their output behind when copying a terminal selection; default on. */
  terminalCopyTrimsGutter: boolean
  /** Enables OSC 52 clipboard writes for TUIs (tmux/Zellij/nvim, incl. over SSH); default on. Clipboard *queries* stay blocked and payload size is capped, so this is write-only exposure. */
  terminalAllowOsc52Clipboard: boolean
  /** One-shot stamp: profiles saved under the old off default get flipped on once, after which an explicit opt-out sticks. */
  terminalAllowOsc52ClipboardDefaultedOnForAllUsers?: boolean
  /** Experimental Claude Agent Teams; native panes use a tmux-compatible shim so teammate output stays on the normal PTY path. */
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  terminalScrollbackRows: number
  /** Optional app-level proxy for Electron networking and local PTYs; empty preserves system/inherited proxy env. */
  httpProxyUrl?: string
  /** Optional semicolon/comma/newline-separated bypass rules for httpProxyUrl. */
  httpProxyBypassRules?: string
  /** Optional mirror of nodejs.org/dist for the Node runtime Orca installs on SSH and WSL servers. */
  nodeDistMirrorUrl?: string
  /** Why: corporate TLS-intercepting proxies can break HTTP/2 downloads; opt-in Chromium process-wide HTTP/1.1 switch. */
  electronHttp1CompatibilityMode?: boolean
  /** Opt-in in-app browsing (isolated guest surface); default keeps links opening in the system browser. */
  openLinksInApp: boolean
  /** Worktree-scoped localhost hostnames to distinguish tabs; opt-in since a non-localhost host can break apps binding cookies/sessions to localhost. */
  localhostWorktreeLabelsEnabled?: boolean
  /** Tracks the one-time first-use prompt for terminal link routing (avoid silently changing where links open). */
  openLinksInAppPreferencePrompted: boolean
  /** Opt-in: Shift+modifier click inverts openLinksInApp instead of always forcing the system browser. Off keeps the historical one-way escape hatch. */
  openLinksInAppModifierInverts?: boolean
  /** Show link actions on plain click in the terminal and chat; off restores modifier-click-only terminal links. */
  terminalLinkActionPopoverEnabled?: boolean
  /** Plain-click behavior for terminal links; optional for profiles saved before this setting existed. */
  terminalLinkClickBehavior?: 'actions' | 'open' | 'none'
  /** Middle mouse URL behavior; defaults to opening the primary routed destination. */
  terminalUrlMiddleClickBehavior?: 'open' | 'actions' | 'none'
  /** Opt-in resume of working structured chats after restart; off still lists them for review before token spending. */
  nativeChatResumeWorkOnRestart?: boolean
  /** Queue follow-ups while the agent works on capable hosts; absent means on. */
  nativeChatQueueFollowUps?: boolean
  /** Teach newly started native chats to create inline visuals; absent means on. */
  nativeChatInlineVisuals?: boolean
  /** Hovering a web link in chat fetches the page to preview it; absent means on. GitHub cards ignore this. */
  nativeChatLinkPreviews?: boolean
  /** Structured Codex/Claude chats inherit the login-shell env; off limits it to nativeChatShellEnvironmentVariables plus PATH/locale. */
  nativeChatInheritShellEnvironment?: boolean
  /** Login-shell variable names structured chat inherits while the whole environment is off. */
  nativeChatShellEnvironmentVariables?: string[]
  /** Last explicit native-chat model + option selections; live panes need an applied/dispatched record before showing a value. */
  nativeChatSessionOptions?: PersistedNativeChatSessionOptions
  /** Legacy client permission control and host-support marker; kept valid for old peers. */
  nativeChatPermissionMode?: AgentChatPermissionMode
  /** Extra launcher rows for the worktree "Open in" submenu. VS Code is always shown first. */
  openInApplications?: OpenInApplication[]
  /** Deprecated: migration/backward-compat only. Use PersistedUIState.rightSidebarOpen. */
  rightSidebarOpenByDefault: boolean
  followSymlinkedDirectories?: boolean
  showGitIgnoredFiles?: boolean
  /** Preferred Source Control changes layout. Per-user, not per-workspace. */
  sourceControlViewMode: SourceControlViewMode
  /** Preferred Source Control group order. Per-user, not per-workspace. */
  sourceControlGroupOrder: SourceControlGroupOrder
  /** Compare base defaults to the branch upstream instead of the repo default; affects only the compare/diff view, not the PR/rebase target. Per-user. */
  sourceControlCompareAgainstUpstream: boolean
  /** Whether to show the Orca app name in the titlebar. */
  showTitlebarAppName: boolean
  /** Hides the Tasks sidebar button (also removes it from keyboard navigation). */
  showTasksButton: boolean
  /** Only toggles the sidebar shortcut; Automations stay reachable from Settings/View menu. */
  showAutomationsButton?: boolean
  /** Deprecated: Artifacts are always available. Use showArtifactsButton for sidebar visibility. */
  artifactsEnabled?: boolean
  /** Capability gate for agent-driven publishing; off until granted, enforced in main, not just the UI. */
  artifactSharingEnabled?: boolean
  /** Capability gate for agent/CLI skill publishing; manual reviewed publishing remains available. */
  agentSkillSharingEnabled?: boolean
  /** Maximum worker nesting; 1 forbids sub-workers. Renderer-only: omit from SettingsUpdate RPC so workers cannot raise their cap. */
  nestedWorkerMaxDepth?: number
  /** Escalate native-chat worker turn errors to the dispatching Run; absent means on. Renderer-only so workers cannot silence failures via CLI. */
  /** Close a finished worker's terminal or chat after a grace period; absent means on. The coordinator's runtime decides. */
  orchestrationWorkerAutoReleaseEnabled?: boolean
  /** Only toggles the sidebar shortcut; Artifacts stay reachable from Settings. */
  showArtifactsButton?: boolean
  /** Only toggles the sidebar shortcut; Skills stay reachable from Settings. */
  showSkillsButton?: boolean
  /** Only toggles the sidebar shortcut; Orca Mobile stays reachable from Settings. */
  showMobileButton?: boolean
  /** Pinned workspaces show in one sidebar location by default; opt in to also show them in their natural groups. */
  showPinnedWorktreesInGroups?: boolean
  /** How Ctrl+Tab picks the next visible tab; optional (older profiles), readers default to MRU. */
  ctrlTabOrderMode?: CtrlTabOrderMode
  /** Orca-first keeps app shortcuts from TUIs; terminal-first is opt-in to let shell/TUI bindings win. */
  terminalShortcutPolicy?: TerminalShortcutPolicy
  /** Floating Workspace: global surface for terminal/browser/markdown tabs outside repo/worktree context. */
  floatingTerminalEnabled: boolean
  /** Main-side new-page kill switch for paired Electron client-hosted browser placement. */
  browserClientHostedRemoteEnabled?: boolean
  /** Browser profile new tabs in a workspace use; missing = 'shared' (the Default profile). */
  browserProfileScope?: BrowserProfileScope
  /** Profile new tabs use per browser host when no repo/workspace profile applies; missing = Default. */
  browserDefaultProfileIdByHostId?: Partial<Record<ExecutionHostId, string>>
  /** Routes SSH-workspace browser pages through the workspace's SSH host; off = plain local browsing. */
  browserSshWorkspaceRoutingEnabled?: boolean
  /** Per-target opt-outs recorded from the routing error card's "Browse from this device instead". */
  browserSshWorkspaceRoutingDisabledTargetIds?: string[]
  /** Targets whose forwarding preflight the user overrode via "Try anyway" (e.g. PermitOpen allows their sites); skips the probe, never changes egress. */
  browserSshWorkspaceRoutingProbeSkippedTargetIds?: string[]
  /** One-shot migration flag for the floating-workspace default-on rollout; after migration an explicit off sticks. */
  floatingTerminalDefaultedForAllUsers?: boolean
  /** Start dir for new floating-workspace terminal tabs; empty or '~' = home dir. */
  floatingTerminalCwd: string
  /** Picker-approved floating-workspace dirs reauthorized across restarts; renderer text alone must not populate this. */
  floatingTerminalTrustedCwds?: string[]
  /** One-shot migration marker for legacy floating workspace cwd trust grants. */
  floatingTerminalCwdMigratedToAppWorkspace?: boolean
  /** Where the Floating Workspace toggle is shown; defaults to the floating button for discoverability. */
  floatingTerminalTriggerLocation: FloatingTerminalTriggerLocation
  /** Legacy keyboard-shortcut overrides; new writes go to ~/.orca/keybindings.json, migrated once when present. */
  keybindings?: KeybindingOverrides
  diffDefaultView: 'inline' | 'side-by-side'
  diffWordWrap: boolean
  diffShowWhitespace: boolean
  /** Opt-in: single-file diffs collapse unchanged regions, as the combined diff view already does; optional for legacy settings. */
  diffCollapseUnchangedRegions?: boolean
  combinedDiffFileTreeVisibleByDefault: boolean
  /** Bot-marked comment-author logins (stored lowercased); escape hatch for review bots on regular accounts that defeat provider metadata/heuristics. */
  prBotAuthorOverrides: string[]
  notifications: NotificationSettings
  /** Countdown after a Claude agent goes idle showing time left before the prompt cache expires. */
  promptCacheTimerEnabled: boolean
  /** Prompt-cache TTL (ms); only 300000 (5 min standard) or 3600000 (1 hr, extended-TTL plans). */
  promptCacheTtlMs: number
  /** Why: durable main-owned pref so Orca can prepare shared ~/.codex before the renderer hydrates. */
  codexManagedAccounts: CodexManagedAccount[]
  activeCodexManagedAccountId: string | null
  activeCodexManagedAccountIdsByRuntime?: CodexManagedAccountRuntimeSelection
  /** Why: persist only per-account auth (not a CLAUDE_CONFIG_DIR swap) so switching accounts doesn't fork Claude's shared chat/session context. */
  claudeManagedAccounts: ClaudeManagedAccount[]
  activeClaudeManagedAccountId: string | null
  activeClaudeManagedAccountIdsByRuntime?: ClaudeManagedAccountRuntimeSelection
  /** Dismissed the "System default may hold a copied login" notice in Settings > Accounts. */
  claudeCopiedSystemDefaultNoticeDismissed?: boolean
  /** Scope bash/zsh HISTFILE and fish_history by worktree so ArrowUp does not expose other worktrees’ commands; default true. */
  terminalScopeHistoryByWorktree: boolean
  /** Kill switch for hidden terminal view parking: unmount long-hidden panes while a pane-less watcher keeps PTY side effects alive. */
  terminalHiddenViewParking?: boolean
  /** Kill switch for SSH terminal parking (C1): SSH panes park like local ones; reveal restores from main's headless model, falling back to relay replay. */
  terminalSshViewParking?: boolean
  /** Kill switch for the hidden-worktree retention budget (C1): force-parks the least-recently-hidden un-parkable worktrees beyond a count budget or TTL. */
  terminalHiddenWorktreeRetentionBudget?: boolean
  /** Kill switch for the browser-guest worktree retention budget: destroys the least-recently-activated hidden worktrees' webview guests beyond an LRU count budget. */
  browserGuestWorktreeRetentionBudget?: boolean
  /** Kill switch for main-process PTY side-effect authority; on (default) = title/bell/agent facts via pty:sideEffect channel, not renderer byte parsing. */
  terminalMainSideEffectAuthority?: boolean
  /** Kill switch for main's hidden-delivery gate (Phase 4): drops PTY bytes to hidden views after model ingestion; requires terminalMainSideEffectAuthority. */
  terminalHiddenDeliveryGate?: boolean
  /** Kill switch for main's model query responder (Phase 5); active only when both Phase-4 gates are also on. */
  terminalModelQueryAuthority?: boolean
  /** New-workspace agent: null chooses first detected, blank launches no agent, otherwise select that TuiAgent. */
  defaultTuiAgent: TuiAgent | 'blank' | null
  /** @deprecated Retained for older peers; setup-only is now a per-create choice. */
  newWorkspaceSetupOnly?: boolean
  /** Agents hidden from picker/auto-launch; detection stays a raw PATH snapshot. */
  disabledTuiAgents: TuiAgent[]
  /** One-shot guard: start Claude Agent Teams hidden for existing profiles without overriding later opt-ins. */
  claudeAgentTeamsDefaultDisabledMigrated?: boolean
  /** One-shot guard: hosts saved before the remote CLI control default flip were pinned off. */
  sshRemoteCliControlExistingHostsMigrated?: boolean
  /** Why: closing a terminal with child processes kills foreground work; keep this skip separate from other confirmations. */
  skipCloseTerminalWithRunningProcessConfirm: boolean
  /** Why: deleting an automation also deletes its run history; keep this skip separate from worktree deletion. */
  skipDeleteAutomationConfirm: boolean
  /** Why: deleting an artifact breaks a public link others may already hold; keep this skip separate from local deletions. */
  skipDeleteArtifactConfirm: boolean
  /** Why: a Codex rate-limit reset spends a scarce credit on the live account; keep this skip separate from local confirmations. */
  skipCodexRateLimitResetConfirm: boolean
  /** Default preset in the new-workspace GitHub task view. */
  defaultTaskViewPreset: TaskViewPresetId
  /** Persisted last-used task source so Tasks reopens to the same provider instead of defaulting to GitHub. */
  defaultTaskSource: TaskProvider
  /** Persisted visible task providers; hides unused providers from Tasks chrome and sidebar shortcuts. */
  visibleTaskProviders: TaskProvider[]
  /** Why: one-shot guard to make Jira visible for existing profiles once, without re-adding after a later opt-out. */
  visibleTaskProvidersDefaultedForJira: boolean
  /** Repo selection: null includes all present/future repos; arrays freeze a subset, dropping ineligible ids on load and treating empty as null. */
  defaultRepoSelection: string[] | null
  /** Linear team selection: null includes all; arrays freeze selected team IDs, matching defaultRepoSelection. */
  defaultLinearTeamSelection: string[] | null
  /** Session cookie for OpenCode Go rate-limit fetching. Stored encrypted. */
  opencodeSessionCookie: string
  /** Optional OpenCode Go workspace ID override; when set, skips the workspaces lookup and fetches usage directly. */
  opencodeWorkspaceId: string
  /** Optional MiniMax group id. When empty, the usage fetcher extracts minimax_group_id_v2 from the cookie. */
  minimaxGroupId: string
  /** Comma-separated MiniMax model names to show in the status bar usage window. */
  minimaxUsageModels: string
  /** MiniMax account region; defaults to overseas for existing users. */
  minimaxEndpoint: MiniMaxEndpoint
  /** GLM Coding Plan site whose API key is saved in AI Provider Accounts; defaults to the international Z.AI console. */
  zcodePlanSite?: ZcodePlanSite
  /** Extract OAuth credentials from the local Gemini CLI for rate-limit fetching. Off by default (explicit opt-in). */
  geminiCliOAuthEnabled: boolean
  /** Per-agent CLI command overrides. A missing key means use the catalog default binary name. */
  agentCmdOverrides: Partial<Record<TuiAgent, string>>
  /** Off keeps each Codex home's history to itself: Orca links no sessions between accounts or
   *  into ~/.codex, and removes nothing already linked (#24511). Absent means on (#10770). */
  codexShareHistoryAcrossAccounts?: boolean
  /** Custom CODEX_HOME for Codex session-history discovery (defaults to ~/.codex).
   *  History-only: does not change which account/config/hooks Orca uses. */
  codexSessionSourceHome?: {
    /** Absolute host path; empty/undefined falls back to ~/.codex. */
    host?: string
    /** Per-WSL-distro absolute Linux path; missing distro falls back to <wslHome>/.codex. */
    wsl?: Record<string, string>
  }
  /** Per-agent default CLI arguments appended after the binary/path and before prompts. */
  agentDefaultArgs?: Partial<Record<TuiAgent, string>>
  agentLaunchChoices?: AgentLaunchChoices
  /** Per-agent launch environment defaults used when yolo mode is exposed as env. */
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
  /** One-shot guard for adding yolo-mode default args to untouched agent launch profiles. */
  agentYoloDefaultsMigrated?: boolean
  /** Why: disabling must persist so startup doesn't reinstall global agent hook entries the user just removed. */
  agentStatusHooksEnabled: boolean
  /** Local agent-state-rules.json replaces downloaded/bundled rules for testing. */
  agentStateRulesPath?: string | null
  /** Off ignores downloads/cache and uses bundled rules or local override; absent means on. */
  agentStateRulesLiveUpdates?: boolean
  /** Pre-trust the worktree or folder Orca starts an agent in, so its "trust this folder?" prompt is skipped. Defaults on. */
  agentWorkspaceTrustEnabled: boolean
  /** Why: Codex's shared server runs every tab's hooks with the first tab's env; off opts new terminals back into it. Absent reads as on. */
  codexTerminalServerIsolation?: boolean
  /** Off hides the banner on a typed `codex` that joined Codex's shared server. Absent reads as on. */
  codexSharedServerWarning?: boolean
  /** Dismissed freshness tuples: no write authority, just suppress re-nudging the same official placement/revision. */
  dismissedSkillFreshnessNudges?: string[]
  /** Why: generated tab titles are subjective, so they stay opt-in and manual renames win. */
  tabAutoGenerateTitle: boolean
  /** Why: pinned tabs can still be closed via keyboard/native-menu; this gates that behind a confirmation. Defaults on. */
  confirmClosePinnedTab: boolean
  /** Why: preview tabs reuse one slot per group, so browsing replaces the open file; off makes every open its own tab. Defaults on. */
  editorPreviewTabsEnabled: boolean
  /** When true, Orca requests local awake assertions while hook-reported agents are working. */
  keepComputerAwakeWhileAgentsRun: boolean
  /** Optional for mixed-version compatibility; the legacy boolean maps true to Auto. */
  computerAwakeMode?: ComputerAwakeMode
  /** macOS Option: auto uses keyboard layout (US → Meta, others compose); false composes; true sends Meta on both keys; left/right select one.
   * See docs/terminal-option-key-layout-aware-default.md. */
  terminalMacOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right'
  /** First upgrade resets ambiguous old true defaults to auto, restoring non-US input; guarded so later choices persist. */
  terminalMacOptionAsAltMigrated: boolean
  /** Whether macOS terminal input maps the physical JIS Yen (¥) key to backslash, per common terminal expectation. */
  terminalJISYenToBackslash: boolean
  experimentalMobile: boolean
  /** Why: iOS Simulator is default-on for capable macOS hosts; this is the durable off switch (hides UI, blocks CLI attach). */
  mobileEmulatorEnabled?: boolean
  /** Preferred iOS Simulator UDID for UI auto-attach and agent CLI attach. */
  mobileEmulatorDefaultDeviceUdid?: string | null
  /** Explicit Android SDK root for when auto-discovery (ANDROID_HOME / default path) fails; null (default) auto-discovers. */
  androidSdkPath?: string | null
  /** Phone-fit PTY restore delay after the last mobile subscriber: null holds indefinitely; finite values clamp to 5s–60min. See docs/mobile-fit-hold.md. */
  mobileAutoRestoreFitMs: number | null
  /** New QR pairing: absent/automatic allows Relay + local; local-only restricts to same network. */
  mobilePairingConnectionMode?: 'automatic' | 'local-only'
  /** Explicit custom address restored when generating future mobile pairing codes. */
  mobilePairingCustomAddress?: string | null
  /** Saved custom addresses available in both mobile pairing pickers. */
  mobilePairingCustomAddresses?: string[]
  /** Name this runtime reports to paired clients; empty uses the host's detected name. */
  machineName: string
  /** Opt-in animated pet overlay; off unmounts it and renderer toggles apply immediately. */
  experimentalPet: boolean
  /** Legacy persisted key from before the sidekick -> pet rename; read only during migration, new writes use experimentalPet. */
  experimentalSidekick?: boolean
  /** Experimental: left-sidebar Agents view — threaded feed of agent completions, blocking/unread state, worktree creation. */
  experimentalActivity: boolean
  /** Experimental: pop-out Kanban dashboard for monitoring and opening agent terminals across worktrees. */
  experimentalAgentDashboardPopout?: boolean
  /** Set after the one-time legacy Agents tab introduction has been acknowledged. */
  agentsSidebarIntroShown?: boolean
  /** True when the profile previously opted into the legacy Agents view. */
  agentsSidebarMigratedFromExperimental?: boolean
  /** How the Agent Dashboard opens: an in-window companion board or a separate pop-out window. Defaults to in-window. */
  experimentalAgentDashboardMode?: AgentDashboardMode
  /** Includes stale quiet agents as a fourth Agent Dashboard column. */
  experimentalAgentDashboardShowIdle?: boolean
  /** One-shot migration guard for defaulting the Agents view off; later explicit opt-ins persist normally. */
  experimentalActivityDefaultedOffForAllUsers?: boolean
  /** Experimental: persistent terminal-pane attention ring for bell + agent-completion events. Opt-in while tuning signal/noise. */
  experimentalTerminalAttention: boolean
  /** Experimental: automatically sleep completed, resumable background agent terminals. */
  experimentalAgentHibernation?: boolean
  /** Milliseconds a completed agent must stay idle before hibernation can be considered. */
  agentHibernationIdleMs?: number
  /** Experimental: opt-in preview of the updated worktree-card layout and metadata behavior. */
  experimentalNewWorktreeCardStyle?: boolean
  /** Experimental: per-workspace on-demand environment recipes and setup surface. */
  experimentalEphemeralVms?: boolean
  /** Experimental (Windows): add WSL distros as hosts, each running its own Orca server. */
  experimentalWslHosts?: boolean
  /** Declined the add-project offer to run a `\\wsl.localhost` project's distro as a host. */
  wslHostOfferDismissed?: boolean
  /** Compact worktree cards: hide the metadata row when title and branch say the same thing. */
  compactWorktreeCards: boolean
  /** Legacy persisted key from the Experimental rollout; new writes use compactWorktreeCards. */
  experimentalCompactWorktreeCards?: boolean
  /** Active non-local runtime environment for client-routed RPC; null keeps local desktop behavior. */
  activeRuntimeEnvironmentId?: string | null
  /** GitHub Project pinned/recent/active/last-view state; persistence hydrates defaults for older profiles. */
  githubProjects?: GitHubProjectSettings
  /** AI commit-message config (agent, model, per-model thinking, prompt suffix). Optional to avoid migrating existing profiles. */
  commitMessageAi?: CommitMessageAiSettings
  /** Source-control AI generation settings for commit messages and hosted-review drafts. */
  sourceControlAi?: SourceControlAiSettings
  /** GitLab project preferences (pinned + recent paths). Optional for pre-GitLab profiles; persistence merge fills the default. */
  gitlabProjects?: GitLabProjectSettings
  /** Anonymous telemetry consent, identity, frozen experiments, and daily usage limits; optional before migration. */
  telemetry?: TelemetrySettings
  /** One-shot cohort marker for the tab-switch keybinding swap. 'pending' =
   *  pre-existing install (seed pins old chords, then flips to 'done'); 'done' = fresh install. */
  tabSwitchKeybindingSeed?: 'pending' | 'done'
  /** Voice/dictation settings; persistence merge hydrates getDefaultSettings() values for older profiles. */
  voice?: VoiceSettings
  /** Transcript full-text search consent + retention. Absent means off; nothing indexes until the user opts in. */
  aiVaultSearch?: AiVaultSearchSettings
}

// Retain one import entry point while keeping feature shapes separate from the max-lines-limited settings module.
export type { GhosttyImportPreview } from './ghostty-import-preview'
export type { OrcaWorkspaceLayout } from './orca-workspace-layout'
