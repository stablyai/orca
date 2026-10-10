import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerUpdaterStatusIpcBridge } from './updater-status-ipc-bridge'

const mocks = vi.hoisted(() => ({ setUpdateStatus: vi.fn() }))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      setUpdateStatus: mocks.setUpdateStatus,
      clearDismissedUpdateVersion: vi.fn()
    })
  }
}))

describe('registerUpdaterStatusIpcBridge', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
  })

  it('registers after requesting the snapshot and preserves the current late snapshot overwrite', async () => {
    const order: string[] = []
    let resolveSnapshot: ((status: { state: string }) => void) | undefined
    let statusListener: ((status: { state: string }) => void) | undefined
    const statusCleanup = vi.fn()
    const dismissalCleanup = vi.fn()
    vi.stubGlobal('window', {
      api: {
        updater: {
          getStatus: () => {
            order.push('snapshot')
            return new Promise<{ state: string }>((resolve) => {
              resolveSnapshot = resolve
            })
          },
          onStatus: (listener: (status: { state: string }) => void) => {
            order.push('listener')
            statusListener = listener
            return statusCleanup
          },
          onClearDismissal: () => dismissalCleanup
        }
      }
    })

    const unsubs: (() => void)[] = []
    registerUpdaterStatusIpcBridge(unsubs)

    expect(order).toEqual(['snapshot', 'listener'])
    statusListener?.({ state: 'available' })
    resolveSnapshot?.({ state: 'idle' })
    await Promise.resolve()
    expect(mocks.setUpdateStatus.mock.calls).toEqual([
      [{ state: 'available' }],
      [{ state: 'idle' }]
    ])

    unsubs.forEach((unsubscribe) => unsubscribe())
    expect(statusCleanup).toHaveBeenCalledOnce()
    expect(dismissalCleanup).toHaveBeenCalledOnce()
  })
})
