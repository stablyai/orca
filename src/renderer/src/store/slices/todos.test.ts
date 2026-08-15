import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorktreeTodo } from '../../../../shared/worktree-todo-types'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const updateMeta = vi.fn().mockResolvedValue({})
const updateRepo = vi.fn().mockResolvedValue({})
const mockApi = {
  ui: {
    recordFeatureInteraction: vi.fn().mockResolvedValue({ featureInteractions: {} }),
    set: vi.fn().mockResolvedValue(undefined)
  },
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta
  },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true }) },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: updateRepo,
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

// Why: patch only `window.api` (in place, creating `window` only if absent in
// the node test env) and restore the original in afterEach — rather than
// replacing the whole global, which would clobber any other window properties.
const originalWindow = globalThis.window

function installMockApi(): void {
  const win = globalThis.window ?? ({} as Window & typeof globalThis)
  // @ts-expect-error -- partial api surface mocked for tests
  win.api = mockApi
  globalThis.window = win
}

const REPO = TEST_REPO.id
const WT = `${REPO}::/path/wt`

type TodoOwner = {
  scope: 'worktree' | 'project'
  ownerId: string
}

function makeTodo(overrides: Partial<WorktreeTodo> & Pick<WorktreeTodo, 'id'>): WorktreeTodo {
  // Why: keep the owner id scope-aware so project-scope fixtures use realistic
  // todos — repoId (no worktreeId) for 'project', worktreeId (no repoId) for
  // 'worktree' — instead of always stamping worktreeId.
  const scope = overrides.scope ?? 'worktree'
  return {
    scope,
    ...(scope === 'project' ? { repoId: REPO } : { worktreeId: WT }),
    body: 'todo',
    order: 0,
    authorRole: 'user',
    createdAt: 1000,
    ...overrides
  }
}

function seedTodos(
  store: ReturnType<typeof createTestStore>,
  owner: TodoOwner,
  todos: WorktreeTodo[]
) {
  if (owner.scope === 'worktree') {
    seedStore(store, {
      worktreesByRepo: {
        [REPO]: [makeWorktree({ id: WT, repoId: REPO, todos })]
      }
    })
    return
  }
  seedStore(store, {
    repos: [{ ...TEST_REPO, todos }]
  })
}

function getTodos(store: ReturnType<typeof createTestStore>, owner: TodoOwner): WorktreeTodo[] {
  return store.getState().getTodos(owner.scope, owner.ownerId)
}

const owners: TodoOwner[] = [
  { scope: 'worktree', ownerId: WT },
  { scope: 'project', ownerId: REPO }
]

describe('todos slice', () => {
  beforeEach(() => {
    installMockApi()
    vi.clearAllMocks()
    updateMeta.mockResolvedValue({})
    updateRepo.mockResolvedValue({})
    vi.spyOn(Date, 'now').mockReturnValue(5000)
  })

  afterEach(() => {
    globalThis.window = originalWindow
  })

  it.each(owners)('adds a $scope todo optimistically with the expected shape', async (owner) => {
    const store = createTestStore()
    seedTodos(store, owner, [
      makeTodo({
        id: 't1',
        scope: owner.scope,
        ...(owner.scope === 'worktree' ? { worktreeId: WT } : { repoId: REPO }),
        order: 2
      })
    ])

    const saved = await store.getState().addTodo({
      scope: owner.scope,
      ...(owner.scope === 'worktree' ? { worktreeId: WT } : { repoId: REPO }),
      body: '  new todo  ',
      authorRole: undefined as never
    })

    expect(saved).toEqual(
      expect.objectContaining({
        scope: owner.scope,
        body: 'new todo',
        order: 3,
        authorRole: 'user',
        createdAt: 5000
      })
    )
    expect(saved?.id).toEqual(expect.any(String))
    expect(getTodos(store, owner)).toHaveLength(2)
    expect(getTodos(store, owner)[1]).toEqual(saved)
  })

  it.each(owners)('updates a $scope todo body and timestamp', async (owner) => {
    const store = createTestStore()
    seedTodos(store, owner, [makeTodo({ id: 't1', scope: owner.scope })])

    const ok = await store.getState().updateTodo(owner.scope, owner.ownerId, 't1', '  changed  ')

    expect(ok).toBe(true)
    expect(getTodos(store, owner)[0]).toEqual(
      expect.objectContaining({ id: 't1', body: 'changed', updatedAt: 5000 })
    )
  })

  it.each(owners)('toggles a $scope todo completedAt on and off', async (owner) => {
    const store = createTestStore()
    seedTodos(store, owner, [makeTodo({ id: 't1', scope: owner.scope })])

    const completed = await store
      .getState()
      .toggleTodoComplete(owner.scope, owner.ownerId, 't1', 6000)
    const reopened = await store.getState().toggleTodoComplete(owner.scope, owner.ownerId, 't1')

    expect(completed).toBe(true)
    expect(reopened).toBe(true)
    expect(getTodos(store, owner)[0]).toEqual(
      expect.objectContaining({ id: 't1', completedAt: undefined, updatedAt: 5000 })
    )
  })

  it.each(owners)('deletes a $scope todo', async (owner) => {
    const store = createTestStore()
    seedTodos(store, owner, [
      makeTodo({ id: 't1', scope: owner.scope }),
      makeTodo({ id: 't2', scope: owner.scope, order: 1 })
    ])

    await store.getState().deleteTodo(owner.scope, owner.ownerId, 't1')

    expect(getTodos(store, owner)).toEqual([expect.objectContaining({ id: 't2' })])
  })

  it.each(owners)('reorders $scope todos', async (owner) => {
    const store = createTestStore()
    seedTodos(store, owner, [
      makeTodo({ id: 't1', scope: owner.scope }),
      makeTodo({ id: 't2', scope: owner.scope, order: 1 })
    ])

    const ok = await store.getState().reorderTodos(owner.scope, owner.ownerId, ['t2', 't1'])

    expect(ok).toBe(true)
    expect(getTodos(store, owner)).toEqual([
      expect.objectContaining({ id: 't2', order: 0 }),
      expect.objectContaining({ id: 't1', order: 1 })
    ])
  })

  it('persists worktree todos through updateMeta', async () => {
    const store = createTestStore()
    seedTodos(store, owners[0], [])

    await store.getState().addTodo({
      scope: 'worktree',
      worktreeId: WT,
      body: 'persist me',
      authorRole: 'agent'
    })

    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: WT,
      updates: {
        todos: [expect.objectContaining({ scope: 'worktree', worktreeId: WT, body: 'persist me' })]
      }
    })
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('persists project todos through repo update', async () => {
    const store = createTestStore()
    seedTodos(store, owners[1], [])

    await store.getState().addTodo({
      scope: 'project',
      repoId: REPO,
      body: 'persist me',
      authorRole: 'user'
    })

    expect(updateRepo).toHaveBeenCalledWith({
      repoId: REPO,
      updates: {
        todos: [expect.objectContaining({ scope: 'project', repoId: REPO, body: 'persist me' })]
      }
    })
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it.each(owners)('rolls back a $scope optimistic update when persistence fails', async (owner) => {
    const store = createTestStore()
    const original = [makeTodo({ id: 't1', scope: owner.scope, body: 'old body' })]
    seedTodos(store, owner, original)
    const persistMock = owner.scope === 'worktree' ? updateMeta : updateRepo
    persistMock.mockRejectedValueOnce(new Error('disk full'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await store.getState().updateTodo(owner.scope, owner.ownerId, 't1', 'new body')

    expect(ok).toBe(false)
    expect(getTodos(store, owner)).toBe(original)
    errSpy.mockRestore()
  })

  it('normalizes malformed todo fields before persistence', async () => {
    const store = createTestStore()
    seedTodos(store, owners[0], [
      {
        id: 't1',
        scope: 'invalid',
        worktreeId: WT,
        body: 'malformed',
        completedAt: -1,
        order: Number.NaN,
        authorRole: 'unknown',
        createdAt: 1000,
        updatedAt: 0
      } as unknown as WorktreeTodo
    ])

    await store.getState().updateTodo('worktree', WT, 't1', 'normalized')

    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: WT,
      updates: {
        todos: [
          expect.objectContaining({
            scope: 'worktree',
            body: 'normalized',
            completedAt: undefined,
            order: 0,
            authorRole: 'user',
            updatedAt: 5000
          })
        ]
      }
    })
  })
})
