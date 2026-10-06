import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
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
