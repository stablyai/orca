import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnrestoredPortForward } from '../../../../shared/ssh-types'

const h = vi.hoisted(() => ({ setUnrestoredPortForwards: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setUnrestoredPortForwards: h.setUnrestoredPortForwards }) }
}))

const { createDirectSshUnrestoredForwardSync } =
  await import('./direct-ssh-unrestored-forward-sync')

const HELD: UnrestoredPortForward = {
  localPort: 4100,
  remoteHost: '127.0.0.1',
  remotePort: 80,
  error: 'port in use'
}

describe('saved forwards mirrored from main', () => {
  let resolveRead: (list: UnrestoredPortForward[]) => void = () => {}

  beforeEach(() => {
    h.setUnrestoredPortForwards.mockReset()
    vi.stubGlobal('window', {
      api: {
        ssh: {
          listUnrestoredPortForwards: () =>
            new Promise<UnrestoredPortForward[]>((resolve) => (resolveRead = resolve))
        }
      }
    })
  })

  // A read answered before a removal landed must not bring the removed forward back.
  it('drops a read a newer push superseded', async () => {
    const sync = createDirectSshUnrestoredForwardSync(() => false)
    sync.refresh('t1')
    sync.applyPush('t1', [])
    resolveRead([HELD])
    await Promise.resolve()
    await Promise.resolve()
    expect(h.setUnrestoredPortForwards.mock.calls).toEqual([['t1', []]])
  })

  it('applies a read nothing superseded', async () => {
    const sync = createDirectSshUnrestoredForwardSync(() => false)
    sync.refresh('t1')
    resolveRead([HELD])
    await vi.waitFor(() => expect(h.setUnrestoredPortForwards).toHaveBeenCalledWith('t1', [HELD]))
  })
})
