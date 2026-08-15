import type { AppState } from '../types'
import type {
  Repo,
  Worktree,
  WorktreeTodo,
  WorktreeTodoAuthorRole,
  WorktreeTodoScope
} from '../../../../shared/worktree-todo-types'
import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers'
import { findRepoForHost } from './repo-host-identity'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'

// Why: addTodo accepts only the author-supplied fields; id/createdAt/order are
// assigned by the slice so callers cannot desync the ordering key or identity.
export type TodoInput = {
  scope: WorktreeTodoScope
  /** Required when scope is 'worktree'. */
  worktreeId?: string
  /** Required when scope is 'project'. */
  repoId?: string
  body: string
  authorRole: WorktreeTodoAuthorRole
}

export type TodoMutationResult = {
  previous: WorktreeTodo[] | undefined
  next: WorktreeTodo[]
}

// Why: zustand's setter shape, declared locally so this engine module doesn't
// depend on TodosSlice (which lives in the slice file and references this one).
type TodoSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void

export function generateTodoId(): string {
  return createBrowserUuid()
}

export function normalizeTodo(todo: WorktreeTodo): WorktreeTodo {
  const scope: WorktreeTodoScope = todo.scope === 'project' ? 'project' : 'worktree'
  const authorRole: WorktreeTodoAuthorRole = todo.authorRole === 'agent' ? 'agent' : 'user'
  const rawOrder = (todo as { order?: unknown }).order
  const order = typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : 0
  const rawCompletedAt = (todo as { completedAt?: unknown }).completedAt
  const completedAt =
    typeof rawCompletedAt === 'number' && Number.isFinite(rawCompletedAt) && rawCompletedAt > 0
      ? rawCompletedAt
      : undefined
  const rawUpdatedAt = (todo as { updatedAt?: unknown }).updatedAt
  const updatedAt =
    typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
      ? rawUpdatedAt
      : undefined
  return {
    ...todo,
    scope,
    authorRole,
    order,
    ...(completedAt !== undefined ? { completedAt } : { completedAt: undefined }),
    ...(updatedAt !== undefined ? { updatedAt } : { updatedAt: undefined })
  }
}

// Why: return a stable reference when no todos exist so selectors don't produce
// a fresh `[]` on every store update, which would trigger re-renders in any
// consumer using referential equality. Frozen so an accidental mutation throws.
export const EMPTY_TODOS: readonly WorktreeTodo[] = Object.freeze([])

export function readOwnerTodos(
  state: AppState,
  scope: WorktreeTodoScope,
  ownerId: string
): WorktreeTodo[] | undefined {
  if (scope === 'worktree') {
    return findWorktreeById(state.worktreesByRepo, ownerId)?.todos
  }
  return state.repos.find((repo) => repo.id === ownerId)?.todos
}

export function nextTodoOrder(existing: readonly WorktreeTodo[]): number {
  return existing.reduce((max, todo) => Math.max(max, todo.order), -1) + 1
}

export function ownerIdForInput(input: TodoInput): string | null {
  const ownerId = input.scope === 'worktree' ? input.worktreeId : input.repoId
  return ownerId && ownerId.trim().length > 0 ? ownerId : null
}

// Why: mirror diffComments' settingsForWorktreeOwner so a worktree owned by a
// runtime environment persists through that environment's RPC target.
function settingsForWorktreeOwner(state: AppState, worktreeId: string): AppState['settings'] {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

// Why: mirror the repo slice's owner-settings resolution so a repo pinned to a
// runtime/ssh host persists through the right target instead of the active one.
function settingsForRepoOwner(state: AppState, repoId: string): AppState['settings'] {
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings })
  if (!repo || (!repo.executionHostId && !repo.connectionId)) {
    return state.settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (
    (parsed?.kind === 'local' || parsed?.kind === 'ssh') &&
    state.settings?.activeRuntimeEnvironmentId
  ) {
    return { ...state.settings, activeRuntimeEnvironmentId: null }
  }
  return state.settings
}

function settingsForOwner(
  state: AppState,
  scope: WorktreeTodoScope,
  ownerId: string
): AppState['settings'] {
  return scope === 'worktree'
    ? settingsForWorktreeOwner(state, ownerId)
    : settingsForRepoOwner(state, ownerId)
}

async function persist(
  settings: AppState['settings'],
  scope: WorktreeTodoScope,
  ownerId: string,
  todos: WorktreeTodo[]
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (scope === 'worktree') {
    if (target.kind === 'local') {
      await window.api.worktrees.updateMeta({ worktreeId: ownerId, updates: { todos } })
      return
    }
    await callRuntimeRpc(
      target,
      'worktree.set',
      { worktree: toRuntimeWorktreeSelector(ownerId), todos },
      { timeoutMs: 15_000 }
    )
    return
  }
  if (target.kind === 'local') {
    await window.api.repos.update({ repoId: ownerId, updates: { todos } })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.update',
    { repo: ownerId, updates: { todos } },
    { timeoutMs: 15_000 }
  )
}

// Why: IPC writes from `persist` are not ordered with respect to each other, so
// serialize per owner. Because `run` reads the LATEST store state at execution
// time, a burst of N mutations does not need N writes — only the running write
// plus a single trailing write that captures the final state. We therefore
// coalesce to at most ONE pending persist per owner: while a write is in flight,
// the first follow-up schedules the trailing write and every later mutation
// reuses that same pending promise instead of stacking another. Keyed by
// `scope:ownerId` so a worktree id and a repo id can never collide.
type OwnerPersistState = {
  inFlight: Promise<void> | null
  pending: Promise<void> | null
}

const persistStateByOwner: Map<string, OwnerPersistState> = new Map()

function persistQueueKey(scope: WorktreeTodoScope, ownerId: string): string {
  return `${scope}:${ownerId}`
}

export function enqueueTodoPersist(
  scope: WorktreeTodoScope,
  ownerId: string,
  get: () => AppState
): Promise<void> {
  const key = persistQueueKey(scope, ownerId)
  const run = async (): Promise<void> => {
    const latest = (readOwnerTodos(get(), scope, ownerId) ?? []).map(normalizeTodo)
    await persist(settingsForOwner(get(), scope, ownerId), scope, ownerId, latest)
  }

  let state = persistStateByOwner.get(key)
  if (!state) {
    state = { inFlight: null, pending: null }
    persistStateByOwner.set(key, state)
  }
  const ownerState = state

  // Why: when the in-flight write settles, promote the single pending trailing
  // write (if any) to in-flight, otherwise drop the owner entry once idle. Use
  // `then(.,.)` so a rejected write still advances the queue.
  const afterSettle = (): void => {
    if (ownerState.pending) {
      ownerState.inFlight = ownerState.pending
      ownerState.pending = null
      ownerState.inFlight.then(afterSettle, afterSettle)
    } else {
      ownerState.inFlight = null
      if (persistStateByOwner.get(key) === ownerState) {
        persistStateByOwner.delete(key)
      }
    }
  }

  // No write running → start immediately and return that write's promise.
  if (!ownerState.inFlight) {
    ownerState.inFlight = run()
    ownerState.inFlight.then(afterSettle, afterSettle)
    return ownerState.inFlight
  }
  // A write is running and a trailing write is already scheduled. That pending
  // write reads the latest store state when it runs, so it subsumes this
  // mutation too — reuse it rather than enqueuing another (trailing-coalesce).
  if (ownerState.pending) {
    return ownerState.pending
  }
  // First follow-up while a write is in flight: schedule the single trailing
  // write to run after the current one settles (success or failure).
  ownerState.pending = ownerState.inFlight.then(run, run)
  return ownerState.pending
}

// Why: derive the next list from the latest store snapshot inside the `set`
// updater so two concurrent writes can't clobber each other via a stale closure.
export function mutateTodos(
  set: TodoSet,
  scope: WorktreeTodoScope,
  ownerId: string,
  mutate: (existing: WorktreeTodo[]) => WorktreeTodo[] | null
): TodoMutationResult | null {
  let previous: WorktreeTodo[] | undefined
  let next: WorktreeTodo[] | null = null
  set((s) => {
    if (scope === 'worktree') {
      const repoId = getRepoIdFromWorktreeId(ownerId)
      const repoList = s.worktreesByRepo[repoId]
      if (!repoList) {
        return {}
      }
      const target = repoList.find((w) => w.id === ownerId)
      if (!target) {
        return {}
      }
      previous = target.todos
      const computed = mutate(previous ?? [])
      if (computed === null) {
        return {}
      }
      next = computed
      const nextList: Worktree[] = repoList.map((w) =>
        w.id === ownerId ? { ...w, todos: computed } : w
      )
      return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
    }
    const target = s.repos.find((r) => r.id === ownerId)
    if (!target) {
      return {}
    }
    previous = target.todos
    const computed = mutate(previous ?? [])
    if (computed === null) {
      return {}
    }
    next = computed
    // Why: the repos array can hold the same id across hosts; update every
    // matching entry so all host views of the project stay in sync.
    const nextRepos: Repo[] = s.repos.map((r) => (r.id === ownerId ? { ...r, todos: computed } : r))
    return { repos: nextRepos }
  })
  if (next === null) {
    return null
  }
  return { previous, next }
}

// Why: if the IPC write fails, roll back so what the user sees matches what will
// survive a reload. Identity guard: only revert when the current todos array is
// strictly identical (===) to the `next` this mutation produced — if a later
// write already replaced it, rolling back to our stale `previous` would erase
// that newer state.
export function rollbackTodos(
  set: TodoSet,
  scope: WorktreeTodoScope,
  ownerId: string,
  previous: WorktreeTodo[] | undefined,
  expectedCurrent: WorktreeTodo[]
): void {
  set((s) => {
    if (scope === 'worktree') {
      const repoId = getRepoIdFromWorktreeId(ownerId)
      const repoList = s.worktreesByRepo[repoId]
      if (!repoList) {
        return {}
      }
      const target = repoList.find((w) => w.id === ownerId)
      if (!target || target.todos !== expectedCurrent) {
        return {}
      }
      const nextList: Worktree[] = repoList.map((w) =>
        w.id === ownerId ? { ...w, todos: previous } : w
      )
      return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
    }
    const target = s.repos.find((r) => r.id === ownerId)
    if (!target || target.todos !== expectedCurrent) {
      return {}
    }
    const nextRepos: Repo[] = s.repos.map((r) => (r.id === ownerId ? { ...r, todos: previous } : r))
    return { repos: nextRepos }
  })
}
