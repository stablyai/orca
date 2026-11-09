import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({
  showOrcaCloudCleanupStartedToast: vi.fn(),
  showOrcaCloudCleanupDoneToast: vi.fn(),
  showOrcaCloudCleanupFailedToast: vi.fn<(creationId: string, tryAgain: () => void) => void>()
}))
vi.mock('@/lib/orca-cloud-session-toasts', () => toasts)

import { beginOrcaCloudCancelCleanup, trackOrcaCloudCreateStep } from './orca-cloud-cancel-cleanup'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('Orca Cloud cancel cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { ephemeralVm: { listRuntimes: async () => [] } } })
  })

  it('reports cleaned up only after the create run and the cancel cleanup both settle', async () => {
    const run = deferred<void>()
    const cleanup = deferred<boolean>()
    void trackOrcaCloudCreateStep('c-1', run.promise)
    beginOrcaCloudCancelCleanup('c-1', [cleanup.promise], { createStartedAt: 0, canceledAt: 1000 })
    expect(toasts.showOrcaCloudCleanupStartedToast).toHaveBeenCalledWith('c-1')

    cleanup.resolve(true)
    await flush()
    expect(toasts.showOrcaCloudCleanupDoneToast).not.toHaveBeenCalled()

    run.resolve()
    await flush()
    expect(toasts.showOrcaCloudCleanupDoneToast).toHaveBeenCalledWith('c-1')
    expect(toasts.showOrcaCloudCleanupFailedToast).not.toHaveBeenCalled()
  })

  it('reports a failure when a cleanup left the sandbox running', async () => {
    beginOrcaCloudCancelCleanup('c-2', [Promise.resolve(false)], {
      createStartedAt: 0,
      canceledAt: 1000
    })
    await flush()
    expect(toasts.showOrcaCloudCleanupFailedToast).toHaveBeenCalledWith('c-2', expect.any(Function))
    expect(toasts.showOrcaCloudCleanupDoneToast).not.toHaveBeenCalled()
  })

  it('reports a failure the runtime records show after the create cleaned up on its own', async () => {
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          listRuntimes: async () => [
            {
              id: 'other',
              recipe: { provider: 'orca-cloud' },
              status: 'cleanup_failed',
              createdAt: 50
            },
            {
              id: 'mine',
              recipe: { provider: 'orca-cloud' },
              status: 'cleanup_failed',
              createdAt: 200
            }
          ]
        }
      }
    })
    beginOrcaCloudCancelCleanup('c-3', [], { createStartedAt: 100, canceledAt: 1000 })
    await flush()
    expect(toasts.showOrcaCloudCleanupFailedToast).toHaveBeenCalledWith('c-3', expect.any(Function))
  })

  it("ignores another create's failed cleanup", async () => {
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          listRuntimes: async () => [
            {
              id: 'other',
              recipe: { provider: 'orca-cloud' },
              status: 'cleanup_failed',
              createdAt: 50
            }
          ]
        }
      }
    })
    beginOrcaCloudCancelCleanup('c-4', [], { createStartedAt: 100, canceledAt: 1000 })
    await flush()
    expect(toasts.showOrcaCloudCleanupDoneToast).toHaveBeenCalledWith('c-4')
  })

  it("Try again deletes only this create's sandbox whose delete failed", async () => {
    const cleanupCalls: string[] = []
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          listRuntimes: async () => [
            {
              id: 'mine',
              recipe: { provider: 'orca-cloud' },
              status: 'cleanup_failed',
              createdAt: 200
            },
            { id: 'later', recipe: { provider: 'orca-cloud' }, status: 'running', createdAt: 2000 }
          ],
          cleanup: async ({ runtimeId }: { runtimeId: string }) => {
            cleanupCalls.push(runtimeId)
            return { cleanupStatus: 'succeeded' }
          }
        }
      }
    })
    beginOrcaCloudCancelCleanup('c-5', [Promise.resolve(false)], {
      createStartedAt: 100,
      canceledAt: 1000
    })
    await flush()
    const tryAgain = toasts.showOrcaCloudCleanupFailedToast.mock.calls[0]?.[1]
    expect(tryAgain).toBeTypeOf('function')
    tryAgain?.()
    await flush()
    expect(cleanupCalls).toEqual(['mine'])
    expect(toasts.showOrcaCloudCleanupStartedToast).toHaveBeenCalledTimes(2)
  })
})
