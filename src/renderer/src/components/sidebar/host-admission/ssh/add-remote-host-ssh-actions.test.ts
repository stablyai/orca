import { describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), toastMocks)
}))

import { loadSshConfigHostsForPicker } from './add-remote-host-ssh-actions'

describe('SSH config picker response admission', () => {
  it('accepts the legacy preload array without exposing an unbounded row list', async () => {
    const hosts = Array.from({ length: 150 }, (_, index) => ({
      alias: `host-${index}`,
      hostname: `host-${index}`,
      port: 22,
      username: '',
      alreadyInOrca: index === 0
    }))
    const result = await loadSshConfigHostsForPicker({
      listConfigHosts: vi.fn().mockResolvedValue(hosts)
    } as never)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toMatchObject({
        totalHostCount: 150,
        newHostCount: 149,
        matchCount: 150,
        hasMore: true
      })
      expect(result.result.hosts).toHaveLength(100)
    }
  })
})
