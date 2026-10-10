import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ownAgentLaunchWorkspaceActivation } from '@/lib/agent-launch-workspace-activation'
import { createWorktreeEventRuntime } from './worktree-event-runtime'

const { activateAndRevealWorktree } = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree }))

const initialState = useAppStore.getState()
afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it.each([false, true])(
  'keeps async activation tied to its publishing connection (current=%s)',
  async (stillCurrent) => {
    const fetched = Promise.withResolvers<void>()
    const fetchWorktrees = vi.spyOn(initialState, 'fetchWorktrees').mockImplementation(async () => {
      await fetched.promise
      return false
    })
    useAppStore.setState({
      fetchWorktrees: initialState.fetchWorktrees,
      getKnownWorktreeById: vi.fn(() => undefined)
    })
    const unsubs: (() => void)[] = []
    const runtime = createWorktreeEventRuntime(unsubs, () => false)
    let current = true
    try {
      const activation = runtime.activateNotifiedWorktree(
        { type: 'activateWorktree', repoId: 'same-repo', worktreeId: 'same-wt', navigation: 'all' },
        {
          allowRuntimeEnvironment: true,
          executionHostId: 'runtime:host-a',
          isCurrent: () => current
        }
      )
      expect(fetchWorktrees).toHaveBeenCalledWith('same-repo', {
        executionHostId: 'runtime:host-a'
      })
      current = stillCurrent
      fetched.resolve()
      await activation
      if (stillCurrent) {
        expect(activateAndRevealWorktree).toHaveBeenCalledWith('same-wt', {
          executionHostId: 'runtime:host-a',
          notifyHostRuntime: false
        })
      } else {
        expect(activateAndRevealWorktree).not.toHaveBeenCalled()
      }
    } finally {
      fetched.resolve()
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
  }
)

function launchActivation() {
  vi.spyOn(initialState, 'fetchWorktrees').mockResolvedValue(false)
  useAppStore.setState({
    fetchWorktrees: initialState.fetchWorktrees,
    getKnownWorktreeById: vi.fn(() => undefined)
  })
  return createWorktreeEventRuntime([], () => false).activateNotifiedWorktree(
    {
      type: 'activateWorktree',
      repoId: 'repo-1',
      worktreeId: 'wt-new',
      launch: { operationId: 'op-1' }
    },
    { allowRuntimeEnvironment: false }
  )
}

it('hands a launch-created workspace to the launch this window is running', async () => {
  const owner = vi.fn()
  const release = ownAgentLaunchWorkspaceActivation('op-1', owner)
  try {
    await launchActivation()

    expect(owner).toHaveBeenCalledWith('wt-new')
    // The launch decides whether to show it (the user may have moved on), not the activation.
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  } finally {
    release()
  }
})

it('opens a launch-created workspace with no shell of its own when no launch here owns it', async () => {
  await launchActivation()

  expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-new', {
    providesInitialSurface: true,
    notifyHostRuntime: false
  })
})
