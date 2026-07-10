import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/unread-badge-count', () => ({
  getUnreadBadgeCount: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: vi.fn()
}))

import { clearUnreadDockBadgeCount } from './useUnreadDockBadge'

describe('clearUnreadDockBadgeCount', () => {
  let setUnreadDockBadgeCount: ReturnType<typeof vi.fn>

  beforeEach(() => {
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

  it('treats badge clearing as best-effort', async () => {
    setUnreadDockBadgeCount.mockRejectedValueOnce(new Error('dock unavailable'))

    clearUnreadDockBadgeCount()
    await Promise.resolve()

    expect(setUnreadDockBadgeCount).toHaveBeenCalledWith(0)
  })
})
