import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { makeLineage } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

// Why: design §4.4 — purgeWorktreeTerminalState wipes every worktree-scoped map symmetrically so no entry is stranded.
describe('purgeWorktreeTerminalState direct (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('wipes tab-id-keyed maps (terminalLayoutsByTabId, ptyIdsByTabId) and clears actives', () => {
    const store = createTestStore()

    store.setState({
      tabsByWorktree: {
        'repoA::/a/wt1': [
          { id: 'tab-1', worktreeId: 'repoA::/a/wt1' },
          { id: 'tab-2', worktreeId: 'repoA::/a/wt1' }
        ],
        'repoA::/a/wt2': [{ id: 'tab-3', worktreeId: 'repoA::/a/wt2' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': { panes: [] },
        'tab-2': { panes: [] },
        'tab-3': { panes: [] }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'], 'tab-3': ['pty-3'] },
      expandedPaneByTabId: { 'tab-1': true, 'tab-2': false, 'tab-3': true },
      canExpandPaneByTabId: { 'tab-1': true, 'tab-2': true, 'tab-3': false },
      runtimePaneTitlesByTabId: { 'tab-1': 'claude', 'tab-3': 'bash' },
      automaticAgentResumeClaimsByTabId: {
        'tab-1': {
          worktreeId: 'repoA::/a/wt1',
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' }
        },
        'tab-3': {
          worktreeId: 'repoA::/a/wt2',
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-3' }
        }
      },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repoA::/a/wt1',
          filePath: '/a/wt1/a.ts',
          relativePath: 'a.ts',
          language: 'typescript',
          isDirty: false,
          markdownPreviewSourceFileId: 'source-1',
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorDrafts: { 'file-1': 'draft', 'file-99': 'other' },
      markdownFrontmatterVisible: { 'source-1': true, 'file-99': true },
      gitIgnoredPathsByWorktree: {
        'repoA::/a/wt1': ['dist/'],
        'repoA::/a/wt2': ['coverage/']
      },
      gitStatusHeadByWorktree: {
        'repoA::/a/wt1': 'head-1',
        'repoA::/a/wt2': 'head-2'
      },
      gitBranchLineTotalByWorktree: {
        'repoA::/a/wt1': { added: 24, removed: 3, mergeBase: 'base-1' },
        'repoA::/a/wt2': { added: 1, removed: 0, mergeBase: 'base-2' }
      },
      gitBranchCompareRequestStatusHeadByWorktree: {
        'repoA::/a/wt1': 'head-1',
        'repoA::/a/wt2': 'head-2'
      },
      rightSidebarTabByWorktree: {
        'repoA::/a/wt1': 'search' as never,
        'repoA::/a/wt2': 'checks'
      },
      activeWorktreeId: 'repoA::/a/wt1',
      worktreeLineageById: {
        'repoA::/a/wt1': makeLineage({ worktreeId: 'repoA::/a/wt1' }),
        'repoA::/a/wt2': makeLineage({ worktreeId: 'repoA::/a/wt2' })
      },
      activeFileId: 'file-1',
      activeTabId: 'tab-1',
      activeTabType: 'editor' as const
    } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState(['repoA::/a/wt1'])

    const s = store.getState()
    expect(s.tabsByWorktree).toEqual({
      'repoA::/a/wt2': [{ id: 'tab-3', worktreeId: 'repoA::/a/wt2' }]
    })
    expect(s.worktreeLineageById).toEqual({
      'repoA::/a/wt2': makeLineage({ worktreeId: 'repoA::/a/wt2' })
    })
    expect(s.terminalLayoutsByTabId).toEqual({ 'tab-3': { panes: [] } })
    expect(s.ptyIdsByTabId).toEqual({ 'tab-3': ['pty-3'] })
    expect(s.expandedPaneByTabId).toEqual({ 'tab-3': true })
    expect(s.canExpandPaneByTabId).toEqual({ 'tab-3': false })
    expect(s.runtimePaneTitlesByTabId).toEqual({ 'tab-3': 'bash' })
    expect(s.automaticAgentResumeClaimsByTabId).toEqual({
      'tab-3': {
        worktreeId: 'repoA::/a/wt2',
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-3' }
      }
    })
    expect(s.openFiles).toEqual([])
    expect(s.editorDrafts).toEqual({ 'file-99': 'other' })
    expect(s.markdownFrontmatterVisible).toEqual({ 'file-99': true })
    expect(s.gitStatusHeadByWorktree).toEqual({ 'repoA::/a/wt2': 'head-2' })
    expect(s.gitBranchLineTotalByWorktree).toEqual({
      'repoA::/a/wt2': { added: 1, removed: 0, mergeBase: 'base-2' }
    })
    expect(s.gitBranchCompareRequestStatusHeadByWorktree).toEqual({
      'repoA::/a/wt2': 'head-2'
    })
    expect(s.gitIgnoredPathsByWorktree).toEqual({ 'repoA::/a/wt2': ['coverage/'] })
    expect(s.rightSidebarTabByWorktree).toEqual({ 'repoA::/a/wt2': 'checks' })
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
  })

  it('is a no-op when the id list is empty', () => {
    const store = createTestStore()
    const before = {
      'repoA::/a/wt1': [{ id: 'tab-1', worktreeId: 'repoA::/a/wt1' }]
    }
    store.setState({ tabsByWorktree: before } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState([])

    expect(store.getState().tabsByWorktree).toBe(before)
  })

  it('ignores the floating workspace sentinel while purging mixed real ids', () => {
    const store = createTestStore()
    const staleId = 'repoA::/a/wt1'
    const floatingFile = {
      id: 'floating-file',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      filePath: '/floating/note.md',
      relativePath: 'note.md',
      language: 'markdown',
      isDirty: false,
      isPreview: false,
      mode: 'edit' as const
    }

    store.setState({
      tabsByWorktree: {
        [staleId]: [{ id: 'tab-1', worktreeId: staleId }],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { id: 'floating-terminal-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
        ]
      },
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'floating-browser', url: 'https://orca.test' }]
      },
      openFiles: [
        floatingFile,
        {
          id: 'stale-file',
          worktreeId: staleId,
          filePath: '/a/wt1/stale.ts',
          relativePath: 'stale.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-file',
        [staleId]: 'stale-file'
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-unified-tab',
            type: 'editor',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            fileId: 'floating-file'
          }
        ],
        [staleId]: [{ id: 'stale-unified-tab', worktreeId: staleId }]
      },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: 'floating-unified-tab'
          }
        ],
        [staleId]: [{ id: 'stale-group', worktreeId: staleId, activeTabId: 'stale-unified-tab' }]
      },
      layoutByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: { type: 'leaf', groupId: 'floating-group' },
        [staleId]: { type: 'leaf', groupId: 'stale-group' }
      }
    } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState([staleId, FLOATING_TERMINAL_WORKTREE_ID])

    expect(store.getState().tabsByWorktree).toEqual({
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        { id: 'floating-terminal-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
      ]
    })
    expect(store.getState().browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      { id: 'floating-browser', url: 'https://orca.test' }
    ])
    expect(store.getState().openFiles).toEqual([floatingFile])
    expect(store.getState().activeFileIdByWorktree).toEqual({
      [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-file'
    })
    expect(store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual({
      type: 'leaf',
      groupId: 'floating-group'
    })
  })

  it('is a no-op when only the floating workspace sentinel is passed', () => {
    const store = createTestStore()
    const tabsByWorktree = {}
    const browserTabsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'floating-browser', url: 'https://orca.test' }]
    }
    const openFiles = [
      {
        id: 'floating-file',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        filePath: '/floating/note.md',
        relativePath: 'note.md',
        language: 'markdown',
        isDirty: false,
        isPreview: false,
        mode: 'edit' as const
      }
    ]
    const unifiedTabsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        {
          id: 'floating-unified-tab',
          type: 'editor',
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          fileId: 'floating-file'
        }
      ]
    }
    const groupsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        {
          id: 'floating-group',
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          activeTabId: 'floating-unified-tab'
        }
      ]
    }
    const layoutByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: { type: 'leaf', groupId: 'floating-group' }
    }

    store.setState({
      tabsByWorktree,
      browserTabsByWorktree,
      openFiles,
      activeFileIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-file' },
      unifiedTabsByWorktree,
      groupsByWorktree,
      layoutByWorktree
    } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState([FLOATING_TERMINAL_WORKTREE_ID])

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(store.getState().browserTabsByWorktree).toBe(browserTabsByWorktree)
    expect(store.getState().openFiles).toBe(openFiles)
    expect(store.getState().unifiedTabsByWorktree).toBe(unifiedTabsByWorktree)
    expect(store.getState().groupsByWorktree).toBe(groupsByWorktree)
    expect(store.getState().layoutByWorktree).toBe(layoutByWorktree)
  })
})
