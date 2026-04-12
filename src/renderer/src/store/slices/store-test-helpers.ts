import { create } from 'zustand'
import type { AppState } from '../types'
import type {
  Worktree,
  TerminalTab,
  TerminalLayoutSnapshot,
  Tab,
  TabGroup
} from '../../../../shared/types'
import type { OpenFile } from './editor'
import { createRepoSlice } from './repos'
import { createWorktreeSlice } from './worktrees'
import { createTerminalSlice } from './terminals'
import { createTabsSlice } from './tabs'
import { createUISlice } from './ui'
import { createSettingsSlice } from './settings'
import { createGitHubSlice } from './github'
import { createEditorSlice } from './editor'
import { createStatsSlice } from './stats'
import { createClaudeUsageSlice } from './claude-usage'
import { createCodexUsageSlice } from './codex-usage'
import { createBrowserSlice } from './browser'
import { createRateLimitSlice } from './rate-limits'

export const TEST_REPO = {
  id: 'repo1',
  path: '/repo1',
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 0
}

export function createTestStore() {
  return create<AppState>()((...a) => ({
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
    ...createCodexUsageSlice(...a),
    ...createBrowserSlice(...a),
    ...createRateLimitSlice(...a)
  }))
}

export function seedStore(
  store: ReturnType<typeof createTestStore>,
  state: Partial<AppState>
): void {
  // The cascade tests intentionally centralize the default repo fixture here
  // so the test files can stay under the enforced max-lines limit without
  // disabling the lint rule and hiding further growth.
  store.setState({
    repos: [TEST_REPO],
    ...state
  })
}

export function makeWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string }
): Worktree {
  return {
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

export function makeTab(
  overrides: Partial<TerminalTab> & { id: string; worktreeId: string }
): TerminalTab {
  return {
    ptyId: null,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

export function makeLayout(): TerminalLayoutSnapshot {
  return { root: null, activeLeafId: null, expandedLeafId: null }
}

export function makeOpenFile(
  overrides: Partial<OpenFile> & { id: string; worktreeId: string }
): OpenFile {
  return {
    filePath: overrides.id,
    relativePath: 'file.ts',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

export function makeUnifiedTab(
  overrides: Partial<Tab> & { id: string; worktreeId: string; groupId: string }
): Tab {
  return {
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

export function makeTabGroup(
  overrides: Partial<TabGroup> & { id: string; worktreeId: string }
): TabGroup {
  return {
    activeTabId: null,
    tabOrder: [],
    ...overrides
  }
}
