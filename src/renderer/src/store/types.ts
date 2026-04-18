import type { RepoSlice } from './slices/repos'
import type { SparsePresetsSlice } from './slices/sparse-presets'
import type { WorktreeSlice } from './slices/worktrees'
import type { TerminalSlice } from './slices/terminals'
import type { TabsSlice } from './slices/tabs'
import type { UISlice } from './slices/ui'
import type { SettingsSlice } from './slices/settings'
import type { GitHubSlice } from './slices/github'
import type { LinearSlice } from './slices/linear'
import type { EditorSlice } from './slices/editor'
import type { StatsSlice } from './slices/stats'
import type { MemorySlice } from './slices/memory'
import type { ClaudeUsageSlice } from './slices/claude-usage'
import type { CodexUsageSlice } from './slices/codex-usage'
import type { BrowserSlice } from './slices/browser'
import type { RateLimitSlice } from './slices/rate-limits'
import type { SshSlice } from './slices/ssh'
import type { AgentStatusSlice } from './slices/agent-status'
import type { DiffCommentsSlice } from './slices/diffComments'
import type { DetectedAgentsSlice } from './slices/detected-agents'
import type { WorktreeNavHistorySlice } from './slices/worktree-nav-history'
import type { DictationSlice } from './slices/dictation'

export type AppState = RepoSlice &
  SparsePresetsSlice &
  WorktreeSlice &
  TerminalSlice &
  TabsSlice &
  UISlice &
  SettingsSlice &
  GitHubSlice &
  LinearSlice &
  EditorSlice &
  StatsSlice &
  MemorySlice &
  ClaudeUsageSlice &
  CodexUsageSlice &
  BrowserSlice &
  RateLimitSlice &
  SshSlice &
  AgentStatusSlice &
  DiffCommentsSlice &
  DetectedAgentsSlice &
  WorktreeNavHistorySlice &
  DictationSlice
