import type { RepoSlice } from './repos/repo-state'
import type { SparsePresetsSlice } from './slices/sparse-presets'
import type { WorktreeSlice } from './slices/worktrees'
import type { TerminalSlice } from './terminals/terminal-state'
import type { TabsSlice } from './slices/tabs'
import type { UISlice } from './slices/ui/ui-slice-contract'
import type { SettingsSlice } from './slices/settings/create-settings-slice'
import type { KeybindingsSlice } from './slices/keybindings'
import type { GitHubSlice } from './github/github-slice-contract'
import type { HostedReviewSlice } from './slices/hosted-review/hosted-review'
import type { LinearSlice } from './slices/linear/linear-slice-contract'
import type { PreflightSlice } from './slices/preflight'
import type { JiraSlice } from './slices/jira/jira-slice-contract'
import type { EditorSlice } from './slices/editor/types/editor-slice'
import type { StatsSlice } from './slices/stats'
import type { MemorySlice } from './slices/memory'
import type { WorkspaceSpaceSlice } from './slices/workspace-space'
import type {
  ClaudeUsageSlice,
  CodexUsageSlice,
  MuseUsageSlice,
  OpenCodeUsageSlice
} from './slices/usage-provider-slices'
import type { BrowserSlice } from './slices/browser/browser-slice-contract'
import type { RateLimitSlice } from './slices/rate-limits'
import type { SshSlice } from './slices/ssh'
import type { RuntimeEnvironmentSshSlice } from './slices/runtime-environment-ssh'
import type { WslHostsSlice } from './slices/wsl-hosts'
import type { AgentStatusSlice } from './slices/agent-status/agent-status-slice-contract'
import type { PaneForegroundAgentSlice } from './slices/pane-foreground-agent'
import type { DiffCommentsSlice } from './slices/diff-comments/create-diff-comments-slice'
import type { DetectedAgentsSlice } from './slices/detected-agents'
import type { RuntimeDetectedAgentsSlice } from './slices/runtime-detected-agents'
import type { WorktreeNavHistorySlice } from './slices/worktree-nav-history'
import type { DictationSlice } from './slices/dictation'
import type { WorkspaceCleanupSlice } from './slices/workspace-cleanup/create-workspace-cleanup-slice'
import type { WorkspaceCleanupBrowseSlice } from './slices/workspace-cleanup/workspace-cleanup-browse'
import type { RuntimeStatusSlice } from './slices/runtime-status'
import type { PullRequestGenerationSlice } from './slices/hosted-review/generation/pull-request-generation-state'
import type { CommitMessageGenerationSlice } from './slices/commit-message-generation'
import type { PinnedTabCloseConfirmSlice } from './slices/pinned-tab-close-confirm'
import type { RecentlyClosedTabsSlice } from './slices/recently-closed-tabs'
import type { OrcaProfilesSlice } from './slices/orca-profiles/create-orca-profiles-slice'
import type { NewIssueDraftSlice } from './slices/new-issue-draft'
import type { FeedbackDraftSlice } from './slices/feedback-draft'
import type { TaskCreationDraftsSlice } from './slices/task-creation-drafts'
import type { RemoteServerUpdatesSlice } from './slices/remote-server-updates'
import type { TerminalQuickCommandHostsSlice } from './slices/terminal-quick-command-hosts'
import type { StructuredSessionLaunchDirectorySlice } from './slices/structured-session-launch-directories'
import type { StructuredChatSleptAtSlice } from './slices/structured-chat-slept-at'
import type { WorkspaceAttentionSlice } from './slices/workspace-attention/workspace-attention-contract'

export type AppState = RepoSlice &
  SparsePresetsSlice &
  WorktreeSlice &
  TerminalSlice &
  TabsSlice &
  UISlice &
  SettingsSlice &
  KeybindingsSlice &
  GitHubSlice &
  HostedReviewSlice &
  LinearSlice &
  PreflightSlice &
  JiraSlice &
  EditorSlice &
  StatsSlice &
  MemorySlice &
  WorkspaceSpaceSlice &
  ClaudeUsageSlice &
  CodexUsageSlice &
  OpenCodeUsageSlice &
  MuseUsageSlice &
  BrowserSlice &
  RateLimitSlice &
  SshSlice &
  RuntimeEnvironmentSshSlice &
  WslHostsSlice &
  AgentStatusSlice &
  PaneForegroundAgentSlice &
  DiffCommentsSlice &
  DetectedAgentsSlice &
  RuntimeDetectedAgentsSlice &
  WorktreeNavHistorySlice &
  DictationSlice &
  WorkspaceCleanupSlice &
  WorkspaceCleanupBrowseSlice &
  RuntimeStatusSlice &
  PullRequestGenerationSlice &
  CommitMessageGenerationSlice &
  PinnedTabCloseConfirmSlice &
  RecentlyClosedTabsSlice &
  OrcaProfilesSlice &
  NewIssueDraftSlice &
  FeedbackDraftSlice &
  TaskCreationDraftsSlice &
  RemoteServerUpdatesSlice &
  TerminalQuickCommandHostsSlice &
  StructuredSessionLaunchDirectorySlice &
  StructuredChatSleptAtSlice &
  WorkspaceAttentionSlice
