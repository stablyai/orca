import type { ExecutionHostId } from './execution-host'
import type { GitHubProjectSettings } from './github/project-types'
import type { VoiceSettings } from './speech-types'
import type { GitLabProjectSettings } from './gitlab-types'
import type { TaskProvider } from './task-providers'
import type { KeybindingOverrides, TerminalShortcutPolicy } from './keybindings'
import type { AppIconId } from './app-icon'
import type { SourceControlAiSettings } from './source-control-ai-types'
import type { ClaudeAgentTeamsMode } from './claude-agent-teams-tmux-compat'
import type { TerminalCustomTheme } from './terminal-custom-themes'
import type { UiLanguage } from './ui-language'
import type { GlobalWindowsRuntimeDefault } from './project-execution-runtime'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'
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
import type {
  AgentDashboardMode,
  BranchPrefixStrategy,
  FloatingTerminalTriggerLocation,
  LeftSidebarAppearanceMode,
  OpenInApplication,
  SourceControlGroupOrder,
  SourceControlViewMode,
  TaskViewPresetId
} from './ui-chrome-types'
import type { SetupScriptLaunchMode } from './worktree/launch-types'
import type {
  CustomWorktreeVisibilitySource,
  ExternalWorktreeVisibility,
  WorktreeVisibilitySourcePreferences
} from './repo-types'

export type WorktreeVisibilityDefaults = {
  /** Default for worktrees outside a recognized source. */
  external?: ExternalWorktreeVisibility
  /** Host-owned roots applied to every repository on that host. */
  customSources?: CustomWorktreeVisibilitySource[]
  /** Defaults for built-in and host-owned custom sources. */
  sourcePreferences?: WorktreeVisibilitySourcePreferences
}

export type GlobalSettings = {
  workspaceDir: string
  /** Host-owned defaults used when a repository has no explicit visibility override. */
  worktreeVisibilityDefaults?: WorktreeVisibilityDefaults
  /** Per-host overrides keyed by ExecutionHostId. Effective value for a
   *  host-varying setting is `host override ?? client default`. */
  hostSettingOverrides?: Partial<Record<ExecutionHostId, HostSettingOverrides>>
  nestWorkspaces: boolean
  workspaceDirHistory?: OrcaWorkspaceLayout[]
  refreshLocalBaseRefOnWorktreeCreate: boolean
  /** Set once the user dismisses the "local main is behind" suggestion toast, so
   *  the nudge to enable refreshLocalBaseRefOnWorktreeCreate never shows again. */
  localBaseRefSuggestionDismissed: boolean
  /** When enabled, Orca renames a workspace's auto-generated creature branch to
   *  a short name derived from the first prompt once work begins. Users can
   *  still turn this off from global Git settings. */
  autoRenameBranchFromWork: boolean
  /** One-shot migration guard for the default-on rollout. Existing profiles
   *  without the guard are flipped on once; later explicit opt-outs stick. */
  autoRenameBranchFromWorkDefaultedOn?: boolean
  branchPrefix: BranchPrefixStrategy
  branchPrefixCustom: string
  theme: 'system' | 'dark' | 'light'
  /** Controls the left sidebar surface without changing terminal brightness. */
  leftSidebarAppearanceMode: LeftSidebarAppearanceMode
  leftSidebarTintColor?: string
  leftSidebarTintOpacity?: number
  uiLanguage: UiLanguage
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
  /** Why: mirrors terminal selection-paste muscle memory without mutating the
   *  normal system clipboard; Linux and macOS enable it by default, Windows
   *  leaves middle-click semantics unchanged unless the user opts in. */
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
  /** Terminal renderer policy.
   *  - 'auto': try xterm WebGL and fall back to DOM when unsupported or risky.
   *  - 'on': always try xterm WebGL.
   *  - 'off': keep terminal rendering on xterm's DOM renderer. */
  terminalGpuAcceleration: 'auto' | 'on' | 'off'
  /** Whether to enable programming-ligatures rendering via
   *  `@xterm/addon-ligatures`.
   *  - `'auto'` (default): enabled only when the configured font is known to
   *    ship ligatures (Fira Code, JetBrains Mono, Cascadia Code, etc.). This
   *    keeps the out-of-the-box experience right for users who install a
   *    ligature font without touching settings.
   *  - `'on'` / `'off'`: explicit override. Never changes when the user
   *    switches fonts, so "off" always stays off. */
  terminalLigatures: 'auto' | 'on' | 'off'
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
  /** Enables OSC 52 clipboard writes for TUIs (tmux/Zellij/nvim, incl. over SSH); default on. Clipboard *queries* stay blocked and payload size is capped, so this is write-only exposure. */
  terminalAllowOsc52Clipboard: boolean
  /** One-shot stamp: profiles saved under the old off default get flipped on once, after which an explicit opt-out sticks. */
  terminalAllowOsc52ClipboardDefaultedOnForAllUsers?: boolean
  /** Experimental Claude Agent Teams; native panes use a tmux-compatible shim so teammate output stays on the normal PTY path. */
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  /** Where the repo setup script runs on workspace create; defaults to a background "Setup" tab to keep the main terminal usable. */
  setupScriptLaunchMode: SetupScriptLaunchMode
  terminalScrollbackRows: number
  /** Optional app-level proxy for Electron networking and local PTYs; empty preserves system/inherited proxy env. */
  httpProxyUrl?: string
  /** Optional semicolon/comma/newline-separated bypass rules for httpProxyUrl. */
  httpProxyBypassRules?: string
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
  /** Show terminal link actions on plain click; off restores modifier-click-only terminal links. */
  terminalLinkActionPopoverEnabled?: boolean
  /** Opt-in: open new coding-agent tabs in native chat instead of the raw terminal; optional for legacy settings. */
  openAgentTabsInChatByDefault?: boolean
  /** Experimental native chat surface for Claude/Codex sessions; off by default. */
  experimentalNativeChat?: boolean
  /** Last explicit native-chat model + option selections; live panes need an applied/dispatched record before showing a value. */
  nativeChatSessionOptions?: PersistedNativeChatSessionOptions
  /** Extra launcher rows for the worktree "Open in" submenu. VS Code is always shown first. */
  openInApplications?: OpenInApplication[]
  /** Deprecated: migration/backward-compat only. Use PersistedUIState.rightSidebarOpen. */
  rightSidebarOpenByDefault: boolean
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
  /** Per-worktree shell history so ArrowUp doesn't surface other worktrees' commands (a HISTFILE for
   *  bash/zsh, a `fish_history` session name for fish). Defaults to true. */
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
  /** Which agent to pre-select in the new-workspace composer.
   *  - null: auto (first detected agent)
   *  - 'blank': blank terminal (no agent launched)
   *  - TuiAgent: a specific agent id */
  defaultTuiAgent: TuiAgent | 'blank' | null
  /** Agents hidden from picker/auto-launch; detection stays a raw PATH snapshot. */
  disabledTuiAgents: TuiAgent[]
  /** Master switch for the experimental plugin system. Off by default: no
   *  discovery, no panels, no plugin code paths run at all. */
  pluginSystemEnabled: boolean
  /** Qualified plugin keys (`publisher.id`) the user disabled. Discovered
   *  plugins stay listed but are not activated. */
  disabledPlugins: string[]
  /** Consent records: qualified plugin key → capability/worker-trust fingerprint.
   *  A plugin whose current fingerprint differs is pending again, so an update
   *  crossing either trust boundary re-prompts before code runs. Absent key =
   *  never consented. */
  pluginConsents: Record<string, string>
  /** Local directories loaded as dev-mode plugins (manifest hot-reload). */
  devPluginPaths: string[]
  /** One-shot guard: start Claude Agent Teams hidden for existing profiles without overriding later opt-ins. */
  claudeAgentTeamsDefaultDisabledMigrated?: boolean
  /** Why: worktree deletion is destructive (rm -rf of the working dir), so confirm by default. */
  skipDeleteWorktreeConfirm: boolean
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
  /** Persisted repo selection (cross-repo tasks view). null = sticky-all (includes future-added repos);
   *  string[] = frozen curated subset (ineligible ids dropped on load; empty after drop is treated as null). */
  defaultRepoSelection: string[] | null
  /** Persisted Linear team selection (tasks view). Same nullable-array pattern as
   *  defaultRepoSelection: null = sticky-all, string[] = frozen subset of team IDs. */
  defaultLinearTeamSelection: string[] | null
  /** Session cookie for OpenCode Go rate-limit fetching. Stored encrypted. */
  opencodeSessionCookie: string
  /** Optional OpenCode Go workspace ID override; when set, skips the workspaces lookup and fetches usage directly. */
  opencodeWorkspaceId: string
  /** Optional MiniMax group id. When empty, the usage fetcher extracts minimax_group_id_v2 from the cookie. */
  minimaxGroupId: string
  /** Comma-separated MiniMax model names to show in the status bar usage window. */
  minimaxUsageModels: string
  /** Extract OAuth credentials from the local Gemini CLI for rate-limit fetching. Off by default (explicit opt-in). */
  geminiCliOAuthEnabled: boolean
  /** Per-agent CLI command overrides. A missing key means use the catalog default binary name. */
  agentCmdOverrides: Partial<Record<TuiAgent, string>>
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
  /** Per-agent launch environment defaults used when yolo mode is exposed as env. */
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
  /** One-shot guard for adding yolo-mode default args to untouched agent launch profiles. */
  agentYoloDefaultsMigrated?: boolean
  /** Why: disabling must persist so startup doesn't reinstall global agent hook entries the user just removed. */
  agentStatusHooksEnabled: boolean
  /** Dismissed freshness tuples: no write authority, just suppress re-nudging the same official placement/revision. */
  dismissedSkillFreshnessNudges?: string[]
  /** Why: generated tab titles are subjective, so they stay opt-in and manual renames win. */
  tabAutoGenerateTitle: boolean
  /** Why: pinned tabs can still be closed via keyboard/native-menu; this gates that behind a confirmation. Defaults on. */
  confirmClosePinnedTab: boolean
  /** When true, Orca requests local awake assertions while hook-reported agents are working. */
  keepComputerAwakeWhileAgentsRun: boolean
  /** Optional for mixed-version compatibility; the legacy boolean maps true to Auto. */
  computerAwakeMode?: ComputerAwakeMode
  /** macOS Option key: compose layout chars (@ German, € French) vs act as Meta/Esc for readline.
   *  'auto' (default) = layout-aware via navigator.keyboard.getLayoutMap() (US → Meta, else compose);
   *  'false' = compose; 'true' = Meta on both Option keys; 'left'/'right' = only that key is Meta.
   *  See docs/terminal-option-key-layout-aware-default.md. */
  terminalMacOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right'
  /** One-shot migration guard for the 'auto' rollout. Old default 'true' was ambiguous (explicit vs default);
   *  on first upgrade launch, reset a persisted 'true' to 'auto' so non-US keyboards aren't broken by the stale default. */
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
  /** Auto-restore window (ms) for a phone-fit PTY after the last mobile subscriber leaves.
   *  `null` (default) holds phone size indefinitely; a finite value schedules restore.
   *  Clamped on read to [5_000ms, 60min]. See docs/mobile-fit-hold.md. */
  mobileAutoRestoreFitMs: number | null
  /** Preferred mobile pairing path for new QR codes. Missing/'automatic' = Anywhere (Relay + local);
   *  explicit 'local-only' = same-network only. */
  mobilePairingConnectionMode?: 'automatic' | 'local-only'
  /** Explicit custom address restored when generating future mobile pairing codes. */
  mobilePairingCustomAddress?: string | null
  /** Saved custom addresses available in both mobile pairing pickers. */
  mobilePairingCustomAddresses?: string[]
  /** Experimental: floating animated pet in the bottom-right corner. Opt-in cosmetic;
   *  off never mounts the overlay, and toggling takes effect instantly (renderer-side). */
  experimentalPet: boolean
  /** Legacy persisted key from before the sidekick -> pet rename; read only during migration, new writes use experimentalPet. */
  experimentalSidekick?: boolean
  /** Experimental: left-sidebar Agents view — threaded feed of agent completions, blocking/unread state, worktree creation. */
  experimentalActivity: boolean
  /** Experimental: pop-out Kanban dashboard for monitoring and opening agent terminals across worktrees. */
  experimentalAgentDashboardPopout?: boolean
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
  /** Compact worktree cards: hide the metadata row when title and branch say the same thing. */
  compactWorktreeCards: boolean
  /** Legacy persisted key from the Experimental rollout; new writes use compactWorktreeCards. */
  experimentalCompactWorktreeCards?: boolean
  /** Active non-local runtime environment for client-routed RPC; null keeps local desktop behavior. */
  activeRuntimeEnvironmentId?: string | null
  /** GitHub Project mode state (pinned/recent/active project, last view per project).
   *  Optional for pre-feature profiles; the persistence merge hydrates the default. */
  githubProjects?: GitHubProjectSettings
  /** AI commit-message config (agent, model, per-model thinking, prompt suffix). Optional to avoid migrating existing profiles. */
  commitMessageAi?: CommitMessageAiSettings
  /** Source-control AI generation settings for commit messages and hosted-review drafts. */
  sourceControlAi?: SourceControlAiSettings
  /** GitLab project preferences (pinned + recent paths). Optional for pre-GitLab profiles; persistence merge fills the default. */
  gitlabProjects?: GitLabProjectSettings
  /** Anonymous product-telemetry state; optional until the one-shot Store.load() migration populates it.
   *  Holds only consent + identity, not volatile counters — those would amplify the debounced settings write. */
  telemetry?: {
    /** New users: true at install. Existing users: null until they resolve the first-launch banner. */
    optedIn: boolean | null
    /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
    installId: string
    /** Cohort marker: true for pre-existing profiles (gates the opt-in banner), false for fresh installs. */
    existedBeforeTelemetryRelease: boolean
  }
  /** One-shot cohort marker for the tab-switch keybinding swap. 'pending' =
   *  pre-existing install (seed pins old chords, then flips to 'done'); 'done' = fresh install. */
  tabSwitchKeybindingSeed?: 'pending' | 'done'
  /** Local voice/dictation config. Optional for pre-voice profiles; getDefaultSettings() hydrates defaults via the persistence merge. */
  voice?: VoiceSettings
}

export type OrcaWorkspaceLayout = {
  path: string
  nestWorkspaces: boolean
}

export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  configPaths?: string[]
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
  error?: string
}
