import type { RepoSlice } from './slices/repos'
import type { WorktreeSlice } from './slices/worktrees'
import type { TerminalSlice } from './slices/terminals'
import type { TabsSlice } from './slices/tabs'
import type { UISlice } from './slices/ui'
import type { SettingsSlice } from './slices/settings'
import type { GitHubSlice } from './slices/github'
import type { EditorSlice } from './slices/editor'
import type { StatsSlice } from './slices/stats'
import type { ClaudeUsageSlice } from './slices/claude-usage'
import type { BrowserSlice } from './slices/browser'

export type AppState = RepoSlice &
  WorktreeSlice &
  TerminalSlice &
  TabsSlice &
  UISlice &
  SettingsSlice &
  GitHubSlice &
  EditorSlice &
  StatsSlice &
  ClaudeUsageSlice &
  BrowserSlice
