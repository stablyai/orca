import { create } from 'zustand'
import type { AppState } from './types'
import { createRepoSlice } from './slices/repos'
import { createWorktreeSlice } from './slices/worktrees'
import { createTerminalSlice } from './slices/terminals'
import { createTabsSlice } from './slices/tabs'
import { createUISlice } from './slices/ui'
import { createSettingsSlice } from './slices/settings'
import { createGitHubSlice } from './slices/github'
import { createEditorSlice } from './slices/editor'
import { createStatsSlice } from './slices/stats'
import { createClaudeUsageSlice } from './slices/claude-usage'
import { createBrowserSlice } from './slices/browser'

export const useAppStore = create<AppState>()((...a) => ({
  ...createRepoSlice(...a),
  ...createWorktreeSlice(...a),
  ...createTerminalSlice(...a),
  ...createTabsSlice(...a),
  ...createUISlice(...a),
  ...createSettingsSlice(...a),
  ...createGitHubSlice(...a),
  ...createEditorSlice(...a),
  ...createStatsSlice(...a),
  ...createClaudeUsageSlice(...a),
  ...createBrowserSlice(...a)
}))

export type { AppState } from './types'
