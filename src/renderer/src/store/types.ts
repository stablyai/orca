import type { RepoSlice } from './slices/repos'
import type { SparsePresetsSlice } from './slices/sparse-presets'
import type { WorktreeSlice } from './slices/worktrees'
import type { TerminalSlice } from './slices/terminals'
import type { TabsSlice } from './slices/tabs'
import type { UISlice } from './slices/ui'
import type { SettingsSlice } from './slices/settings'
import type { KeybindingsSlice } from './slices/keybindings'
import type { GitHubSlice } from './slices/github'
import type { HostedReviewSlice } from './slices/hosted-review'
import type { LinearSlice } from './slices/linear'
import type { PreflightSlice } from './slices/preflight'
import type { JiraSlice } from './slices/jira'
import type { EditorSlice } from './slices/editor'
import type { StatsSlice } from './slices/stats'
import type { MemorySlice } from './slices/memory'
import type { WorkspaceSpaceSlice } from './slices/workspace-space'
import type { ClaudeUsageSlice } from './slices/claude-usage'
import type { CodexUsageSlice } from './slices/codex-usage'
import type { OpenCodeUsageSlice } from './slices/opencode-usage'
import type { BrowserSlice } from './slices/browser'
import type { RateLimitSlice } from './slices/rate-limits'
import type { SshSlice } from './slices/ssh'
import type { RuntimeEnvironmentSshSlice } from './slices/runtime-environment-ssh'
import type { AgentStatusSlice } from './slices/agent-status'
import type { PaneForegroundAgentSlice } from './slices/pane-foreground-agent'
import type { DiffCommentsSlice } from './slices/diffComments'
import type { DetectedAgentsSlice } from './slices/detected-agents'
import type { RuntimeDetectedAgentsSlice } from './slices/runtime-detected-agents'
import type { WorktreeNavHistorySlice } from './slices/worktree-nav-history'
import type { DictationSlice } from './slices/dictation'
import type { WorkspaceCleanupSlice } from './slices/workspace-cleanup'
import type { RuntimeStatusSlice } from './slices/runtime-status'
import type { PullRequestGenerationSlice } from './slices/pull-request-generation'
import type { CommitMessageGenerationSlice } from './slices/commit-message-generation'
import type { PinnedTabCloseConfirmSlice } from './slices/pinned-tab-close-confirm'
import type { RecentlyClosedTabsSlice } from './slices/recently-closed-tabs'
import type { OrcaProfilesSlice } from './slices/orca-profiles'
import type { NewIssueDraftSlice } from './slices/new-issue-draft'
import type { RemoteServerUpdatesSlice } from './slices/remote-server-updates'

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
  BrowserSlice &
  RateLimitSlice &
  SshSlice &
  RuntimeEnvironmentSshSlice &
  AgentStatusSlice &
  PaneForegroundAgentSlice &
  DiffCommentsSlice &
  DetectedAgentsSlice &
  RuntimeDetectedAgentsSlice &
  WorktreeNavHistorySlice &
  DictationSlice &
  WorkspaceCleanupSlice &
  RuntimeStatusSlice &
  PullRequestGenerationSlice &
  CommitMessageGenerationSlice &
  PinnedTabCloseConfirmSlice &
  RecentlyClosedTabsSlice &
  OrcaProfilesSlice &
  NewIssueDraftSlice &
  RemoteServerUpdatesSlice
