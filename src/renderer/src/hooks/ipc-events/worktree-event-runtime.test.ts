// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT,
  type WorkspaceMultiplexerAddRequestDetail
} from '@/components/workspace-multiplexer/workspace-multiplexer-add-request'
import { createWorktreeEventRuntime } from './worktree-event-runtime'

const store = vi.hoisted(() => ({
  activeWorktreeId: 'repo::/ws/app' as string | null,
  activeWorkspaceExecutionHostId: 'ssh:devbox' as string | null,
  activeView: 'terminal' as 'terminal' | 'multiplexer',
  detectedWorktreesByRepo: {} as Record<string, unknown>,
  worktreesByRepo: {} as Record<string, unknown[]>,
  migrateWorktreeIdentity: vi.fn(),
  fetchWorktrees: vi.fn(async () => {}),
  fetchWorktreeLineage: vi.fn(async () => {}),
  getKnownWorktreeById: vi.fn(),
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
    store.activeView = 'terminal'
    store.getKnownWorktreeById.mockReturnValue(undefined)
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

  it('keeps an open multiplexer visible and requests the activated worktree', async () => {
    store.activeView = 'multiplexer'
    store.getKnownWorktreeById.mockReturnValue({ id: 'wt-new', hostId: 'ssh:devbox' })
    vi.mocked(activateAndRevealWorktree).mockReturnValue({ primaryTabId: null })
    const requests: WorkspaceMultiplexerAddRequestDetail[] = []
    const listener = (event: Event): void => {
      requests.push((event as CustomEvent<WorkspaceMultiplexerAddRequestDetail>).detail)
    }
    window.addEventListener(WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT, listener)

    await createWorktreeEventRuntime([], () => false).activateNotifiedWorktree(
      { type: 'activateWorktree', repoId: 'repo', worktreeId: 'wt-new' },
      { allowRuntimeEnvironment: false }
    )

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-new', {
      preserveActiveView: true,
      notifyHostRuntime: false
    })
    expect(requests).toEqual([{ worktreeId: 'wt-new', executionHostId: 'ssh:devbox' }])
    window.removeEventListener(WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT, listener)
  })
})
