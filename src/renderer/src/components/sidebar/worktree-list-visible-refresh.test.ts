import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWorktreeVisibleRefreshVisibilityListener } from './WorktreeList'

describe('installWorktreeVisibleRefreshVisibilityListener', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('subscribes to document visibility changes so visible PR refresh can rerun on return', () => {
    const listeners = new Map<string, () => void>()
    const onChange = vi.fn()
    const addEventListener = vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
    })
    const removeEventListener = vi.fn()

    vi.stubGlobal('document', {
      addEventListener,
      removeEventListener
    })

    const cleanup = installWorktreeVisibleRefreshVisibilityListener(onChange)

    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', onChange)
    listeners.get('visibilitychange')?.()
    expect(onChange).toHaveBeenCalledTimes(1)

    cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', onChange)
  })
})
