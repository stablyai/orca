import { create } from 'zustand'
import type { AppState } from './types'
import { createRepoSlice } from './slices/repos'
import { createSparsePresetsSlice } from './slices/sparse-presets'
import { createWorktreeSlice } from './slices/worktrees'
import { createTerminalSlice } from './slices/terminals'
import { createTabsSlice } from './slices/tabs'
import { createUISlice } from './slices/ui'
import { createSettingsSlice } from './slices/settings'
import { createGitHubSlice } from './slices/github'
import { createLinearSlice } from './slices/linear'
import { createEditorSlice } from './slices/editor'
import { createStatsSlice } from './slices/stats'
import { createMemorySlice } from './slices/memory'
import { createClaudeUsageSlice } from './slices/claude-usage'
import { createCodexUsageSlice } from './slices/codex-usage'
import { createBrowserSlice } from './slices/browser'
import { createRateLimitSlice } from './slices/rate-limits'
import { createSshSlice } from './slices/ssh'
import { createAgentStatusSlice } from './slices/agent-status'
import { createDiffCommentsSlice } from './slices/diffComments'
import { createDetectedAgentsSlice } from './slices/detected-agents'
import { createWorktreeNavHistorySlice } from './slices/worktree-nav-history'
import { createDictationSlice } from './slices/dictation'
import { e2eConfig } from '@/lib/e2e-config'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'

export const useAppStore = create<AppState>()((...a) => ({
  ...createRepoSlice(...a),
  ...createSparsePresetsSlice(...a),
  ...createWorktreeSlice(...a),
  ...createTerminalSlice(...a),
  ...createTabsSlice(...a),
  ...createUISlice(...a),
  ...createSettingsSlice(...a),
  ...createGitHubSlice(...a),
  ...createLinearSlice(...a),
  ...createEditorSlice(...a),
  ...createStatsSlice(...a),
  ...createMemorySlice(...a),
  ...createClaudeUsageSlice(...a),
  ...createCodexUsageSlice(...a),
  ...createBrowserSlice(...a),
  ...createRateLimitSlice(...a),
  ...createSshSlice(...a),
  ...createAgentStatusSlice(...a),
  ...createDiffCommentsSlice(...a),
  ...createDetectedAgentsSlice(...a),
  ...createWorktreeNavHistorySlice(...a),
  ...createDictationSlice(...a)
}))

registerHttpLinkStoreAccessor(() => useAppStore.getState())

export type { AppState } from './types'

// Why: exposes the Zustand store on window for console debugging (dev) and
// E2E tests (VITE_EXPOSE_STORE). The E2E suite reads store state directly
// to avoid fragile DOM scraping. Harmless — the store is already reachable
// via React DevTools in any environment.
if ((import.meta.env.DEV || e2eConfig.exposeStore) && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__store = useAppStore
}
