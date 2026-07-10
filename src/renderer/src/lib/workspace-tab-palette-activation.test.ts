import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTabPaletteSearchResult } from './workspace-tab-palette-search'

const mocks = vi.hoisted(() => {
  type MockStore = {
    worktreesByRepo: Record<string, { id: string; repoId: string; path: string }[]>
    groupsByWorktree: Record<string, Record<string, unknown>[]>
    unifiedTabsByWorktree: Record<string, Record<string, unknown>[]>
    openFiles: { id: string; worktreeId: string }[]
    repos: unknown[]
    settings: Record<string, unknown>
    activeGroupIdByWorktree: Record<string, string>
    focusGroup: ReturnType<typeof vi.fn>
    activateTab: ReturnType<typeof vi.fn>
    setActiveTab: ReturnType<typeof vi.fn>
    setActiveTabType: ReturnType<typeof vi.fn>
    setActiveFile: ReturnType<typeof vi.fn>
  }
  const store: MockStore = {
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt-1' }]
    },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: 'unified-terminal-1',
          tabOrder: ['unified-terminal-1']
        }
      ]
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'unified-terminal-1',
          entityId: 'terminal-1',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    openFiles: [],
    repos: [],
    settings: {},
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveFile: vi.fn()
  }
  return {
    store,
    activateAndRevealWorktree: vi.fn(),
    activateWebRuntimeSessionTab: vi.fn(),
    focusTerminalTabSurface: vi.fn(),
    getRuntimeEnvironmentIdForWorktree: vi.fn(),
    isWebRuntimeSessionActive: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('./worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activateWorkspaceTabPaletteResult } from './workspace-tab-palette-activation'

function makeResult(
  overrides: Partial<WorkspaceTabPaletteSearchResult> = {}
): WorkspaceTabPaletteSearchResult {
  return {
    tabId: 'unified-terminal-1',
    entityId: 'terminal-1',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    contentType: 'terminal',
    title: 'Terminal',
    secondaryText: 'Terminal tab',
    repoName: 'repo/orca',
    worktreeName: 'Palette Worktree',
    titleRange: null,
    secondaryRange: null,
    repoRange: null,
    worktreeRange: null,
    isCurrentTab: false,
    isCurrentWorktree: false,
    score: 0,
    ...overrides
  }
}

function resetStore(): void {
  mocks.store.worktreesByRepo = {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt-1' }]
  }
  mocks.store.groupsByWorktree = {
    'wt-1': [
      {
        id: 'group-1',
        worktreeId: 'wt-1',
        activeTabId: 'unified-terminal-1',
        tabOrder: ['unified-terminal-1']
      }
    ]
  }
  mocks.store.unifiedTabsByWorktree = {
    'wt-1': [
      {
        id: 'unified-terminal-1',
        entityId: 'terminal-1',
        groupId: 'group-1',
        worktreeId: 'wt-1',
        contentType: 'terminal',
        label: 'Terminal',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
  }
  mocks.store.openFiles = []
}

describe('activateWorkspaceTabPaletteResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('runtime-1')
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
  })

  it('activates terminal tabs and focuses the terminal surface', () => {
    expect(activateWorkspaceTabPaletteResult(makeResult())).toEqual({ status: 'activated' })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(mocks.store.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mocks.store.activateTab).toHaveBeenCalledWith('unified-terminal-1')
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('terminal-1')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-1')
  })

  it('uses the web-runtime terminal activation path when active', () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)

    expect(activateWorkspaceTabPaletteResult(makeResult())).toEqual({ status: 'activated' })

    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'terminal-1',
      environmentId: 'runtime-1'
    })
  })

  it('activates editor-family tabs through the target split group and backing file', () => {
    mocks.store.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'diff-tab-1',
          entityId: '/tmp/wt-1/src/app.ts',
          groupId: 'group-2',
          worktreeId: 'wt-1',
          contentType: 'diff',
          label: 'app.ts (diff)',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
    mocks.store.groupsByWorktree = {
      'wt-1': [
        {
          id: 'group-2',
          worktreeId: 'wt-1',
          activeTabId: 'diff-tab-1',
          tabOrder: ['diff-tab-1']
        }
      ]
    }
    mocks.store.openFiles = [{ id: '/tmp/wt-1/src/app.ts', worktreeId: 'wt-1' }]

    expect(
      activateWorkspaceTabPaletteResult(
        makeResult({
          tabId: 'diff-tab-1',
          entityId: '/tmp/wt-1/src/app.ts',
          groupId: 'group-2',
          contentType: 'diff'
        })
      )
    ).toEqual({ status: 'activated' })

    expect(mocks.store.focusGroup).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mocks.store.setActiveFile).toHaveBeenCalledWith('/tmp/wt-1/src/app.ts')
    expect(mocks.store.activateTab).toHaveBeenLastCalledWith('diff-tab-1')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('editor')
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })

  it.each([
    ['editor' as const, 'editor-tab-1', '/tmp/wt-1/src/app.ts'],
    ['conflict-review' as const, 'conflict-tab-1', 'wt-1::conflict-review'],
    ['check-details' as const, 'check-tab-1', 'wt-1::check-details::check-run:42']
  ])('activates %s tabs with their exact unified tab id', (contentType, tabId, entityId) => {
    mocks.store.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: tabId,
          entityId,
          groupId: 'group-2',
          worktreeId: 'wt-1',
          contentType,
          label: 'Editor tab',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
    mocks.store.groupsByWorktree = {
      'wt-1': [
        {
          id: 'group-2',
          worktreeId: 'wt-1',
          activeTabId: tabId,
          tabOrder: [tabId]
        }
      ]
    }
    mocks.store.openFiles = [{ id: entityId, worktreeId: 'wt-1' }]

    expect(
      activateWorkspaceTabPaletteResult(
        makeResult({
          tabId,
          entityId,
          groupId: 'group-2',
          contentType
        })
      )
    ).toEqual({ status: 'activated' })

    expect(mocks.store.focusGroup).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mocks.store.setActiveFile).toHaveBeenCalledWith(entityId)
    expect(mocks.store.activateTab).toHaveBeenLastCalledWith(tabId)
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('editor')
  })

  it('returns stale failures before focusing a removed group or tab', () => {
    mocks.store.groupsByWorktree = { 'wt-1': [] }

    expect(activateWorkspaceTabPaletteResult(makeResult())).toEqual({
      status: 'failed',
      reason: 'missing-group'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.store.focusGroup).not.toHaveBeenCalled()

    resetStore()
    mocks.store.unifiedTabsByWorktree = { 'wt-1': [] }
    expect(activateWorkspaceTabPaletteResult(makeResult())).toEqual({
      status: 'failed',
      reason: 'missing-tab'
    })
    expect(mocks.store.focusGroup).not.toHaveBeenCalled()
  })

  it('treats missing editor backing files and worktrees as stale', () => {
    mocks.store.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'editor-tab-1',
          entityId: '/tmp/wt-1/src/app.ts',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'editor',
          label: 'app.ts',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }

    expect(
      activateWorkspaceTabPaletteResult(
        makeResult({
          tabId: 'editor-tab-1',
          entityId: '/tmp/wt-1/src/app.ts',
          contentType: 'editor'
        })
      )
    ).toEqual({ status: 'failed', reason: 'missing-file' })

    resetStore()
    mocks.store.worktreesByRepo = {}
    expect(activateWorkspaceTabPaletteResult(makeResult())).toEqual({
      status: 'failed',
      reason: 'missing-worktree'
    })
  })
})
