/* eslint-disable max-lines -- Why: this test file owns the diff-comments
slice's persistence, runtime routing, rollback, and compatibility behavior. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment, Worktree } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

// Mock sonner (imported transitively by other slices)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const updateMeta = vi.fn().mockResolvedValue({})
const runtimeEnvironmentCall = vi.fn().mockResolvedValue({
  id: 'rpc-1',
  ok: true,
  result: { ok: true },
  _meta: { runtimeId: 'remote-runtime' }
})
const runtimeEnvironmentTransportCall = vi.fn()
const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta
  },
  runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  gh: { prForBranch: vi.fn().mockResolvedValue(null), issue: vi.fn().mockResolvedValue(null) },
  settings: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  },
  claudeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyClaudeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  codexUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyCodexData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createRepoSlice } from './repos'
import { createSparsePresetsSlice } from './sparse-presets'
import { createWorktreeSlice } from './worktrees'
import { createTerminalSlice } from './terminals'
import { createTabsSlice } from './tabs'
import { createUISlice } from './ui'
import { createSettingsSlice } from './settings'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import { createLinearSlice } from './linear'
import { createEditorSlice } from './editor'
import { createStatsSlice } from './stats'
import { createMemorySlice } from './memory'
import { createWorkspaceSpaceSlice } from './workspace-space'
import { createClaudeUsageSlice } from './claude-usage'
import { createCodexUsageSlice } from './codex-usage'
import { createBrowserSlice } from './browser'
import { createRateLimitSlice } from './rate-limits'
import { createSshSlice } from './ssh'
import { createAgentStatusSlice } from './agent-status'
import { createDiffCommentsSlice } from './diffComments'
import { createDetectedAgentsSlice } from './detected-agents'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import { createDictationSlice } from './dictation'
import { createWorkspaceCleanupSlice } from './workspace-cleanup'

function createTestStore() {
  return create<AppState>()((...a) => ({
    ...createRepoSlice(...a),
    ...createSparsePresetsSlice(...a),
    ...createWorktreeSlice(...a),
    ...createTerminalSlice(...a),
    ...createTabsSlice(...a),
    ...createUISlice(...a),
    ...createSettingsSlice(...a),
    ...createGitHubSlice(...a),
    ...createHostedReviewSlice(...a),
    ...createLinearSlice(...a),
    ...createEditorSlice(...a),
    ...createStatsSlice(...a),
    ...createMemorySlice(...a),
    ...createWorkspaceSpaceSlice(...a),
    ...createClaudeUsageSlice(...a),
    ...createCodexUsageSlice(...a),
    ...createBrowserSlice(...a),
    ...createRateLimitSlice(...a),
    ...createSshSlice(...a),
    ...createAgentStatusSlice(...a),
    ...createDiffCommentsSlice(...a),
    ...createDetectedAgentsSlice(...a),
    ...createWorktreeNavHistorySlice(...a),
    ...createDictationSlice(...a),
    ...createWorkspaceCleanupSlice(...a)
  }))
}

const REPO = 'repo1'
const WT = 'repo1::/path/wt'

function makeWorktree(diffComments: DiffComment[]): Worktree {
  return {
    id: WT,
    repoId: REPO,
    path: '/path/wt',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    diffComments
  }
}

function seed(store: ReturnType<typeof createTestStore>, comments: DiffComment[]): void {
  store.setState({
    worktreesByRepo: { [REPO]: [makeWorktree(comments)] }
  })
}

describe('addDiffComment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    updateMeta.mockResolvedValue({})
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('persists source and startLine for ranged comments', async () => {
    const store = createTestStore()
    seed(store, [])

    const saved = await store.getState().addDiffComment({
      worktreeId: WT,
      filePath: 'README.md',
      source: 'markdown',
      startLine: 2,
      lineNumber: 4,
      body: 'range note',
      side: 'modified'
    })

    expect(saved).toEqual(
      expect.objectContaining({
        filePath: 'README.md',
        source: 'markdown',
        startLine: 2,
        lineNumber: 4,
        body: 'range note'
      })
    )
    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: WT,
      updates: {
        diffComments: [
          expect.objectContaining({
            source: 'markdown',
            startLine: 2,
            lineNumber: 4
          })
        ]
      }
    })
  })
})

describe('updateDiffComment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    updateMeta.mockResolvedValue({})
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('updates the body, trims it, and persists', async () => {
    const store = createTestStore()
    const original: DiffComment = {
      id: 'c1',
      worktreeId: WT,
      filePath: 'src/foo.ts',
      lineNumber: 10,
      body: 'old body',
      createdAt: 1000,
      side: 'modified'
    }
    seed(store, [original])

    const ok = await store.getState().updateDiffComment(WT, 'c1', '  new body  ')

    expect(ok).toBe(true)
    const saved = store.getState().getDiffComments(WT)[0]
    expect(saved.body).toBe('new body')
    // identity-preserving fields untouched
    expect(saved.id).toBe('c1')
    expect(saved.lineNumber).toBe(10)
    expect(saved.createdAt).toBe(1000)
    expect(updateMeta).toHaveBeenCalledTimes(1)
  })

  it('persists through the selected runtime environment', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })
    seed(store, [
      {
        id: 'c1',
        worktreeId: WT,
        filePath: 'src/foo.ts',
        lineNumber: 10,
        body: 'old body',
        createdAt: 1000,
        side: 'modified'
      }
    ])

    const ok = await store.getState().updateDiffComment(WT, 'c1', 'remote body')

    expect(ok).toBe(true)
    expect(updateMeta).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: {
        worktree: WT,
        diffComments: [expect.objectContaining({ id: 'c1', body: 'remote body' })]
      },
      timeoutMs: 15_000
    })
  })

  it('rejects an empty body without persisting', async () => {
    const store = createTestStore()
    seed(store, [
      {
        id: 'c1',
        worktreeId: WT,
        filePath: 'src/foo.ts',
        lineNumber: 10,
        body: 'old body',
        createdAt: 1000,
        side: 'modified'
      }
    ])

    const ok = await store.getState().updateDiffComment(WT, 'c1', '   ')

    expect(ok).toBe(false)
    expect(store.getState().getDiffComments(WT)[0].body).toBe('old body')
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('returns true and is a no-op for an unchanged body', async () => {
    const store = createTestStore()
    seed(store, [
      {
        id: 'c1',
        worktreeId: WT,
        filePath: 'src/foo.ts',
        lineNumber: 10,
        body: 'same',
        createdAt: 1000,
        side: 'modified'
      }
    ])

    const ok = await store.getState().updateDiffComment(WT, 'c1', 'same')

    expect(ok).toBe(true)
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('returns false when the comment id is missing (edit-while-deleted race)', async () => {
    const store = createTestStore()
    seed(store, [])

    const ok = await store.getState().updateDiffComment(WT, 'missing', 'anything')

    expect(ok).toBe(false)
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('rolls back on persist failure', async () => {
    const store = createTestStore()
    seed(store, [
      {
        id: 'c1',
        worktreeId: WT,
        filePath: 'src/foo.ts',
        lineNumber: 10,
        body: 'old body',
        createdAt: 1000,
        side: 'modified'
      }
    ])
    updateMeta.mockRejectedValueOnce(new Error('disk full'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await store.getState().updateDiffComment(WT, 'c1', 'new body')

    expect(ok).toBe(false)
    expect(store.getState().getDiffComments(WT)[0].body).toBe('old body')
    errSpy.mockRestore()
  })
})
