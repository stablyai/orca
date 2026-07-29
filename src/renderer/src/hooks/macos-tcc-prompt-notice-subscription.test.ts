import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissMacosTccPromptNotice,
  subscribeToMacosTccPromptNotice
} from './macos-tcc-prompt-notice-subscription'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('subscribeToMacosTccPromptNotice', () => {
  it('contains synchronous and rejected dismissal failures', async () => {
    const synchronousFailure = vi.fn(() => {
      throw new Error('renderer closing')
    })
    const rejectedFailure = vi.fn().mockRejectedValue(new Error('ipc unavailable'))

    await expect(
      dismissMacosTccPromptNotice({ dismiss: synchronousFailure })
    ).resolves.toBeUndefined()
    await expect(dismissMacosTccPromptNotice({ dismiss: rejectedFailure })).resolves.toBeUndefined()
  })

  it('delivers a threshold retained before the renderer subscribed', async () => {
    const onNotice = vi.fn()
    const acknowledgePending = vi.fn().mockResolvedValue(undefined)
    const unsubscribe = subscribeToMacosTccPromptNotice(
      {
        acknowledgePending,
        consumePending: vi.fn().mockResolvedValue({ claimId: 7, promptCount: 3 }),
        onThreshold: vi.fn(() => vi.fn())
      },
      onNotice
    )

    await Promise.resolve()

    expect(onNotice).toHaveBeenCalledWith({ promptCount: 3 })
    expect(acknowledgePending).toHaveBeenCalledWith(7)
    expect(onNotice.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgePending.mock.invocationCallOrder[0]
    )
    unsubscribe()
  })

  it('consumes concurrent mount and live signals only once', async () => {
    const listenerState: { listener?: (payload: { promptCount: number }) => void } = {}
    const acknowledgePending = vi.fn().mockResolvedValue(undefined)
    const consumePending = vi
      .fn()
      .mockResolvedValueOnce({ claimId: 8, promptCount: 3 })
      .mockResolvedValue(null)
    const onNotice = vi.fn()
    const unsubscribe = subscribeToMacosTccPromptNotice(
      {
        acknowledgePending,
        consumePending,
        onThreshold: (listener) => {
          listenerState.listener = listener
          return vi.fn()
        }
      },
      onNotice
    )

    listenerState.listener?.({ promptCount: 3 })
    await Promise.resolve()

    expect(consumePending).toHaveBeenCalledTimes(2)
    expect(onNotice).toHaveBeenCalledOnce()
    expect(acknowledgePending).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('finishes an in-flight claim through StrictMode cleanup', async () => {
    const pendingState: {
      resolve?: (payload: { claimId: number; promptCount: number } | null) => void
    } = {}
    const onNotice = vi.fn()
    const acknowledgePending = vi.fn().mockResolvedValue(undefined)
    const unsubscribe = subscribeToMacosTccPromptNotice(
      {
        acknowledgePending,
        consumePending: () =>
          new Promise((resolve) => {
            pendingState.resolve = resolve
          })
      },
      onNotice
    )

    unsubscribe()
    pendingState.resolve?.({ claimId: 9, promptCount: 3 })
    await Promise.resolve()

    expect(onNotice).toHaveBeenCalledOnce()
    expect(acknowledgePending).toHaveBeenCalledWith(9)
  })

  it('retries once after releasing a transient failed display', async () => {
    const error = new Error('toast unavailable')
    const acknowledgePending = vi.fn().mockResolvedValue(undefined)
    const consumePending = vi
      .fn()
      .mockResolvedValueOnce({ claimId: 10, promptCount: 3 })
      .mockResolvedValueOnce({ claimId: 11, promptCount: 3 })
    const releasePending = vi.fn().mockResolvedValue(undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onNotice = vi.fn().mockImplementationOnce(() => {
      throw error
    })

    subscribeToMacosTccPromptNotice(
      {
        acknowledgePending,
        consumePending,
        releasePending
      },
      onNotice
    )
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    expect(consumePending).toHaveBeenCalledTimes(2)
    expect(onNotice).toHaveBeenCalledTimes(2)
    expect(releasePending).toHaveBeenCalledWith(10)
    expect(acknowledgePending).toHaveBeenCalledWith(11)
    expect(consoleError).toHaveBeenCalledWith('[macos-tcc-prompts] Failed to show notice:', error)
  })

  it('bounds persistent display failures and release rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const consumePending = vi
      .fn()
      .mockResolvedValueOnce({ claimId: 20, promptCount: 3 })
      .mockResolvedValueOnce({ claimId: 21, promptCount: 3 })
    const releasePending = vi.fn().mockResolvedValue(undefined)
    subscribeToMacosTccPromptNotice(
      {
        acknowledgePending: vi.fn(),
        consumePending,
        releasePending
      },
      () => {
        throw new Error('persistent failure')
      }
    )
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    expect(consumePending).toHaveBeenCalledTimes(2)
    expect(releasePending).toHaveBeenCalledTimes(2)

    const rejectedRelease = vi.fn().mockRejectedValue(new Error('ipc unavailable'))
    const rejectedConsume = vi.fn().mockResolvedValue({ claimId: 22, promptCount: 3 })
    subscribeToMacosTccPromptNotice(
      {
        consumePending: rejectedConsume,
        releasePending: rejectedRelease
      },
      () => {
        throw new Error('display failure')
      }
    )
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    expect(rejectedConsume).toHaveBeenCalledOnce()
    expect(rejectedRelease).toHaveBeenCalledWith(22)
  })

  it('releases the claim when acknowledgement fails or is unavailable', async () => {
    const failedRelease = vi.fn().mockResolvedValue(undefined)
    subscribeToMacosTccPromptNotice(
      {
        acknowledgePending: vi.fn().mockRejectedValue(new Error('renderer closing')),
        consumePending: vi.fn().mockResolvedValue({ claimId: 11, promptCount: 3 }),
        releasePending: failedRelease
      },
      vi.fn()
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(failedRelease).toHaveBeenCalledWith(11)

    const unavailableRelease = vi.fn().mockResolvedValue(undefined)
    subscribeToMacosTccPromptNotice(
      {
        consumePending: vi.fn().mockResolvedValue({ claimId: 12, promptCount: 3 }),
        releasePending: unavailableRelease
      },
      vi.fn()
    )
    await Promise.resolve()
    expect(unavailableRelease).toHaveBeenCalledWith(12)
  })

  it('falls back to live delivery when consuming throws synchronously', async () => {
    const listenerState: { listener?: (payload: { promptCount: number }) => void } = {}
    const onNotice = vi.fn()
    const consumePending = vi.fn(() => {
      throw new Error('ipc unavailable')
    })

    expect(() =>
      subscribeToMacosTccPromptNotice(
        {
          consumePending,
          onThreshold: (listener) => {
            listenerState.listener = listener
            return vi.fn()
          }
        },
        onNotice
      )
    ).not.toThrow()

    listenerState.listener?.({ promptCount: 3 })
    await Promise.resolve()

    expect(consumePending).toHaveBeenCalledTimes(2)
    expect(onNotice).toHaveBeenCalledWith({ promptCount: 3 })
  })

  it('releases the claim when acknowledgement throws synchronously', async () => {
    const releasePending = vi.fn().mockResolvedValue(undefined)
    const onNotice = vi.fn()

    subscribeToMacosTccPromptNotice(
      {
        acknowledgePending: vi.fn(() => {
          throw new Error('ipc unavailable')
        }),
        consumePending: vi.fn().mockResolvedValue({ claimId: 13, promptCount: 3 }),
        releasePending
      },
      onNotice
    )
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    expect(onNotice).toHaveBeenCalledOnce()
    expect(releasePending).toHaveBeenCalledWith(13)
  })

  it('keeps live delivery with an older preload that has no consume API', () => {
    const listenerState: { listener?: (payload: { promptCount: number }) => void } = {}
    const onNotice = vi.fn()
    const unsubscribe = subscribeToMacosTccPromptNotice(
      {
        onThreshold: (listener) => {
          listenerState.listener = listener
          return vi.fn()
        }
      },
      onNotice
    )

    listenerState.listener?.({ promptCount: 3 })

    expect(onNotice).toHaveBeenCalledWith({ promptCount: 3 })
    unsubscribe()
  })
})
