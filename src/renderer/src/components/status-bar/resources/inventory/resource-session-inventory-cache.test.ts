import { describe, expect, it, vi } from 'vitest'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'

describe('a session listing a terminal change outdated', () => {
  it('reads again instead of reporting the daemon as unavailable', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'pty:listSessions': Error: Terminal session owner could not be verified: stale inventory"
        )
      )
      .mockResolvedValueOnce([{ id: 'shell-a', cwd: '/a', title: 'zsh' }])
    const cache = new ResourceSessionInventoryCache(list, false)
    const errors: boolean[] = []
    cache.subscribe(() => errors.push(cache.getSnapshot().sessionsError))

    cache.setActive(true)
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(cache.getSnapshot().loading).toBe(false))

    expect(errors).not.toContain(true)
    expect(cache.getSnapshot().observedAt).not.toBeNull()
  })

  it('still reports a real failure', async () => {
    const list = vi.fn().mockRejectedValue(new Error('daemon unreachable'))
    const cache = new ResourceSessionInventoryCache(list, false)

    cache.setActive(true)
    await vi.waitFor(() => expect(cache.getSnapshot().sessionsError).toBe(true))
    expect(list).toHaveBeenCalledTimes(1)
  })
})
