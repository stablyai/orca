import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { useActivityUnreadCount, useEffect } = vi.hoisted(() => ({
  useActivityUnreadCount: vi.fn(),
  useEffect: vi.fn((effect: () => void) => effect())
}))

vi.mock('react', () => ({ useEffect }))

vi.mock('@/components/activity/useActivityUnreadCount', () => ({
  useActivityUnreadCount
}))

import { clearUnreadDockBadgeCount, useUnreadDockBadge } from './useUnreadDockBadge'

describe('clearUnreadDockBadgeCount', () => {
  let setUnreadDockBadgeCount: ReturnType<typeof vi.fn>

  beforeEach(() => {
    useActivityUnreadCount.mockReset()
    useActivityUnreadCount.mockReturnValue(3)
    useEffect.mockClear()
    setUnreadDockBadgeCount = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        app: {
          setUnreadDockBadgeCount
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears the app badge', () => {
    clearUnreadDockBadgeCount()

    expect(setUnreadDockBadgeCount).toHaveBeenCalledWith(0)
  })

  it('syncs the unread Agent View thread count', () => {
    useUnreadDockBadge()

    expect(useActivityUnreadCount).toHaveBeenCalledWith(true, 'agent-threads')
    expect(setUnreadDockBadgeCount).toHaveBeenCalledWith(3)
  })

  it('treats badge clearing as best-effort', async () => {
    setUnreadDockBadgeCount.mockRejectedValueOnce(new Error('dock unavailable'))

    clearUnreadDockBadgeCount()
    await Promise.resolve()

    expect(setUnreadDockBadgeCount).toHaveBeenCalledWith(0)
  })
})
