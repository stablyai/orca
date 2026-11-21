import type { AppState } from '../../types'
import { selectDiffCommentView, type DiffCommentOwner } from './diff-comment-owner'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { mergeDiffCommentMutation } from '../../../../../shared/file-review/diff-comment-mutation'
import type { Worktree } from '../../../../../shared/worktree/types'
import { SELF_LOCAL_AUTHORITY } from '../../../../../shared/execution-host/host-authority'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
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
  ui: {
    recordFeatureInteraction: vi.fn().mockResolvedValue({ featureInteractions: {} }),
    set: vi.fn().mockResolvedValue(undefined)
  },
  worktrees: {
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
  },
  openCodeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyOpenCodeData: false
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

import { createTestStore } from '../../testing/app-store-test-fixture'
import { resetDiffCommentPersistenceForTests } from './diff-comment-persistence'

beforeEach(resetDiffCommentPersistenceForTests)

const REPO = 'repo1'
const WT = 'repo1::/path/wt'

function makeComment(overrides: Partial<DiffComment> & Pick<DiffComment, 'id'>): DiffComment {
  return {
    worktreeId: WT,
    filePath: 'src/foo.ts',
    lineNumber: 10,
    body: 'body',
    createdAt: 1000,
    side: 'modified',
    ...overrides
  }
}

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

function seed(
  store: ReturnType<typeof createTestStore>,
  comments: DiffComment[],
  worktreeOverrides: Partial<Worktree> = {}
): void {
  store.setState({
    repos: [{ id: REPO, path: '/path/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: { [REPO]: [{ ...makeWorktree(comments), ...worktreeOverrides }] }
  })
}

describe('bulk clear diff comments', () => {
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

  it('does not clobber a later comment array identity when rollback runs', async () => {
    const store = createTestStore()
    const comments = [makeComment({ id: 'c1' })]
    const laterComments = [makeComment({ id: 'c2', body: 'later' })]
    seed(store, comments)
    let rejectPersist: (err: Error) => void = () => {}
    updateMeta.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPersist = reject
        })
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const clearPromise = store.getState().clearDiffComments(capturedOwner(store, WT))
    await Promise.resolve()
    seed(store, laterComments)
    rejectPersist(new Error('disk full'))

    const ok = await clearPromise

    expect(ok).toBe(false)
    expect(store.getState().getDiffComments(WT)).toBe(laterComments)
    errSpy.mockRestore()
  })
})

describe('worktree diff comment rollback convergence', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

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
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
  })

  function addNote(store: ReturnType<typeof createTestStore>, body: string, lineNumber: number) {
    return store.getState().addDiffComment(capturedOwner(store, WT), {
      worktreeId: WT,
      filePath: 'src/foo.ts',
      lineNumber,
      body,
      side: 'modified'
    })
  }

  it('converges to the pre-burst list when two consecutive writes fail', async () => {
    const store = createTestStore()
    const comments = [makeComment({ id: 'c1' })]
    seed(store, comments)
    updateMeta.mockRejectedValue(new Error('disk full'))

    await expect(Promise.all([addNote(store, 'A', 11), addNote(store, 'B', 12)])).resolves.toEqual([
      null,
      null
    ])
    expect(updateMeta).toHaveBeenCalledTimes(2)
    expect(store.getState().getDiffComments(WT)).toBe(comments)
  })
})

describe('desktop note writes beside another device', () => {
  type NoteWrite = { updates: { diffComments?: DiffComment[]; diffCommentsBase?: DiffComment[] } }
  let hostNotes: DiffComment[] = []
  // The host's write rule: merge against the writer's base when it sends one.
  const saveOnHost = ({ updates }: NoteWrite): void => {
    if (!updates.diffComments) {
      return
    }
    hostNotes = updates.diffCommentsBase
      ? mergeDiffCommentMutation(updates.diffCommentsBase, hostNotes, updates.diffComments)
      : updates.diffComments
  }

  beforeEach(() => {
    vi.clearAllMocks()
    updateMeta.mockImplementation(async (write: NoteWrite) => {
      saveOnHost(write)
      return { diffComments: hostNotes }
    })
  })

  it('keeps a note another device saved after this desktop last loaded the list', async () => {
    const store = createTestStore()
    const mine = makeComment({ id: 'mine', body: 'desktop note' })
    seed(store, [mine])
    hostNotes = [mine, makeComment({ id: 'phone', body: 'phone note' })]

    expect(
      await store.getState().updateDiffComment(capturedOwner(store, WT), 'mine', 'edited')
    ).toBe(true)

    expect(hostNotes.map((comment) => comment.body)).toEqual(['edited', 'phone note'])
  })

  it('keeps a note another device saved when this desktop saves after a failed save', async () => {
    const store = createTestStore()
    const mine = makeComment({ id: 'mine', body: 'desktop note' })
    seed(store, [mine])
    hostNotes = [mine]
    updateMeta.mockRejectedValueOnce(new Error('timed out'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const owner = capturedOwner(store, WT)
    await store.getState().updateDiffComment(owner, 'mine', 'never saved')
    hostNotes = [mine, makeComment({ id: 'phone', body: 'phone note' })]

    expect(await store.getState().updateDiffComment(owner, 'mine', 'edited')).toBe(true)

    expect(hostNotes.map((comment) => comment.body)).toEqual(['edited', 'phone note'])
    errSpy.mockRestore()
  })

  it('keeps an edit queued behind a save whose reply was lost after it landed', async () => {
    const store = createTestStore()
    seed(store, [])
    hostNotes = []
    let failLandedSave: () => void = () => {}
    updateMeta.mockImplementationOnce(
      (write: NoteWrite) =>
        new Promise((_, reject) => {
          failLandedSave = () => {
            saveOnHost(write)
            reject(new Error('timed out'))
          }
        })
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const owner = capturedOwner(store, WT)
    const adding = store.getState().addDiffComment(owner, {
      worktreeId: WT,
      filePath: 'src/foo.ts',
      lineNumber: 3,
      body: 'first draft',
      side: 'modified'
    })
    await Promise.resolve()
    const [added] = store.getState().getDiffComments(WT) ?? []
    const editing = store.getState().updateDiffComment(owner, added.id, 'final text')
    failLandedSave()

    await adding
    expect(await editing).toBe(true)
    expect(hostNotes.map((comment) => comment.body)).toEqual(['final text'])
    errSpy.mockRestore()
  })

  it('does not duplicate a note retried after its first save landed but its reply was lost', async () => {
    const store = createTestStore()
    seed(store, [])
    hostNotes = []
    updateMeta.mockImplementationOnce(async (write: NoteWrite) => {
      saveOnHost(write)
      throw new Error('timed out')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const owner = capturedOwner(store, WT)
    const note = {
      worktreeId: WT,
      filePath: 'src/foo.ts',
      lineNumber: 3,
      body: 'retried note',
      side: 'modified' as const
    }

    expect(await store.getState().addDiffComment(owner, note)).toBeNull()
    expect(await store.getState().addDiffComment(owner, note)).not.toBeNull()

    expect(hostNotes.map((comment) => comment.body)).toEqual(['retried note'])
    errSpy.mockRestore()
  })
})

function capturedOwner(store: { getState: () => AppState }, worktreeId: string): DiffCommentOwner {
  return (
    // An unlisted id stands for a copy that is gone, so actions on it are refused.
    selectDiffCommentView(store.getState(), worktreeId, 'selection').owner ?? {
      kind: 'worktree',
      worktreeId,
      authority: SELF_LOCAL_AUTHORITY
    }
  )
}
