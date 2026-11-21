import { describe, expect, it, vi } from 'vitest'
import type { PtyListedSession } from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'

describe('a closing Resource Manager', () => {
  it('retires its in-flight listing so main stops re-reading for it', async () => {
    const requests: string[] = []
    const list = vi.fn(
      (requestId: string) =>
        new Promise<PtyListedSession[]>(() => {
          requests.push(requestId)
        })
    )
    const retire = vi.fn()
    const cache = new ResourceSessionInventoryCache(list, false, retire)

    cache.setActive(true)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    cache.setActive(false)

    expect(retire.mock.calls).toEqual([[requests[0]]])
  })
})
