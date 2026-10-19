import { afterEach, describe, expect, it, vi } from 'vitest'

const { info } = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info } }))

import {
  registerWslAccountNoticeIpcBridge,
  showWslAccountNotAppliedNotice
} from './wsl-account-notice-ipc-bridge'

describe('WSL account-not-applied notice', () => {
  afterEach(() => {
    info.mockReset()
    vi.unstubAllGlobals()
  })

  it('shows a non-blocking info toast keyed by distro', () => {
    showWslAccountNotAppliedNotice({ distro: 'Ubuntu' })
    expect(info).toHaveBeenCalledWith(
      'Account selection not applied in Ubuntu',
      expect.objectContaining({ id: 'wsl-account-not-applied:ubuntu' })
    )
    expect(info.mock.calls[0][1]).not.toHaveProperty('duration')
  })

  it('subscribes to the desktop event and skips a client without one', () => {
    const unsubscribe = vi.fn()
    let listener: ((event: { distro: string }) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          onWslAccountNotApplied: (callback: (event: { distro: string }) => void) => {
            listener = callback
            return unsubscribe
          }
        }
      }
    })
    const unsubs: (() => void)[] = []
    registerWslAccountNoticeIpcBridge(unsubs)
    listener?.({ distro: 'Debian' })
    expect(info).toHaveBeenCalledTimes(1)
    expect(unsubs).toEqual([unsubscribe])

    vi.stubGlobal('window', { api: { runtimeEnvironments: {} } })
    const none: (() => void)[] = []
    registerWslAccountNoticeIpcBridge(none)
    expect(none).toEqual([])
  })
})
