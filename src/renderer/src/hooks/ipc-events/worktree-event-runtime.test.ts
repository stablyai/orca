import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeEventRuntime } from './worktree-event-runtime'

const store = vi.hoisted(() => ({
  activeWorktreeId: 'repo::/ws/app' as string | null,
  activeWorkspaceExecutionHostId: 'ssh:devbox' as string | null,
  detectedWorktreesByRepo: {} as Record<string, unknown>,
  worktreesByRepo: {} as Record<string, unknown[]>,
  migrateWorktreeIdentity: vi.fn(),
  fetchWorktrees: vi.fn(async () => {}),
  fetchWorktreeLineage: vi.fn(async () => {}),
  setActiveWorktree: vi.fn(),
  purgeWorktreeTerminalState: vi.fn(),
  removeWorkspaceSpaceWorktrees: vi.fn()
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

const RENAME = { oldWorktreeId: 'repo::/ws/app', newWorktreeId: 'repo::/ws/app-renamed' }

async function runRename(executionHostId?: 'ssh:devbox'): Promise<void> {
  const runtime = createWorktreeEventRuntime([], () => false)
  runtime.worktreeChangeRefreshQueue.enqueue({ repoId: 'repo', renamed: RENAME, executionHostId })
  await vi.waitFor(() => expect(store.fetchWorktreeLineage).toHaveBeenCalled())
  await Promise.resolve()
}

describe('worktree rename events across execution hosts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.activeWorktreeId = RENAME.oldWorktreeId
    store.activeWorkspaceExecutionHostId = 'ssh:devbox'
  })

  it('leaves a same-id active workspace on another host untouched', async () => {
    await runRename()

    expect(store.migrateWorktreeIdentity).toHaveBeenCalledWith(
      RENAME.oldWorktreeId,
      RENAME.newWorktreeId,
      'local'
    )
    expect(store.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('re-activates the renamed workspace on the event host', async () => {
    await runRename('ssh:devbox')

    expect(store.setActiveWorktree).toHaveBeenCalledWith(RENAME.newWorktreeId, 'ssh:devbox')
  })
})
