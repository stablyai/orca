import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'

type WorktreeMetaSaveState = {
  generation: number
  failureRefresh: Promise<void> | null
}

const saveStatesByStore = new WeakMap<WorktreeSliceGet, Map<string, WorktreeMetaSaveState>>()

function getSaveState(
  get: WorktreeSliceGet,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMetaSaveState {
  let states = saveStatesByStore.get(get)
  if (!states) {
    states = new Map()
    saveStatesByStore.set(get, states)
  }
  const key = `${executionHostId}\0${worktreeId}`
  const existing = states.get(key)
  if (existing) {
    return existing
  }
  const created = { generation: 0, failureRefresh: null }
  states.set(key, created)
  return created
}

export async function startWorktreeMetaSave(
  get: WorktreeSliceGet,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): Promise<{ state: WorktreeMetaSaveState; generation: number } | null> {
  if (!executionHostId) {
    return null
  }
  const state = getSaveState(get, worktreeId, executionHostId)
  await state.failureRefresh?.catch(() => undefined)
  return { state, generation: ++state.generation }
}

export async function reconcileFailedWorktreeMetaSave(
  get: WorktreeSliceGet,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  save: Awaited<ReturnType<typeof startWorktreeMetaSave>>
): Promise<void> {
  if (!save) {
    await get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    return
  }
  const refresh = (save.state.failureRefresh ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (save.state.generation === save.generation) {
        await get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId), { executionHostId })
      }
    })
  save.state.failureRefresh = refresh
  try {
    await refresh
  } finally {
    if (save.state.failureRefresh === refresh) {
      save.state.failureRefresh = null
    }
  }
}
