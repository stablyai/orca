import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  queueHookCommandsForFirstWorktreeTab,
  resetHookCommandDelayedDeliveryForTests
} from './hook-command-delayed-delivery'

const initialState = useAppStore.getState()

afterEach(() => {
  resetHookCommandDelayedDeliveryForTests()
  useAppStore.setState(initialState, true)
})

describe('delayed hook-command subscription', () => {
  it('does not rescan pending worktrees for unrelated store updates', () => {
    const reads = { value: 0 }
    useAppStore.setState({
      tabsByWorktree: {},
      getKnownWorktreeById: ((worktreeId: string) => {
        reads.value += 1
        return { id: worktreeId }
      }) as never
    } as never)

    for (let index = 0; index < 500; index += 1) {
      queueHookCommandsForFirstWorktreeTab({
        worktreeId: `runtime-worktree-${index}`,
        deliver: vi.fn()
      })
    }

    reads.value = 0
    for (let update = 0; update < 100; update += 1) {
      useAppStore.setState({ activeView: update % 2 === 0 ? 'terminal' : 'settings' } as never)
    }

    expect(reads.value).toBe(0)
  })
})
