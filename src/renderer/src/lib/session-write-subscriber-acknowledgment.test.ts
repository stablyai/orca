import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'

function acknowledgment() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('session write acknowledgments', () => {
  let initial: AppState
  let dispose: (() => void) | undefined
  beforeEach(() => {
    initial = useAppStore.getState()
    vi.useFakeTimers()
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
    vi.useRealTimers()
    useAppStore.setState(initial, true)
  })

  function setup() {
    const first = acknowledgment()
    const persist = vi
      .fn<(write: WorkspaceSessionWrite) => void | Promise<void>>()
      .mockImplementationOnce(() => first.promise)
    const onPersistError = vi.fn()
    let wake: (() => void) | undefined
    dispose = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      onPersistError,
      shouldSchedulePersist: () => true,
      subscribeToPersistGateOpen: (listener) => {
        wake = listener
        return () => {
          wake = undefined
        }
      }
    })
    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'old'
    })
    vi.advanceTimersByTime(200)
    return { first, persist, onPersistError, wake: () => wake?.() }
  }

  it('serializes writes and preserves a newer edit to the in-flight field', async () => {
    const { first, persist } = setup()
    useAppStore.setState({ activeTabId: 'new' })
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).toHaveBeenCalledTimes(1)
    first.resolve()
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0].patch.activeTabId).toBe('new')
  })

  it.each(['gate', 'store'] as const)(
    'retains rejected intent until a %s wake and rebuilds fresh state',
    async (source) => {
      const { first, persist, onPersistError, wake } = setup()
      useAppStore.setState({ activeTabId: 'new' })
      first.reject(new Error('retirement publication deferred'))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(persist).toHaveBeenCalledTimes(1)
      expect(onPersistError).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      if (source === 'gate') {
        wake()
      } else {
        useAppStore.getState().setCacheTimerStartedAt('tab:pane', Date.now())
      }
      await vi.advanceTimersByTimeAsync(200)
      expect(persist).toHaveBeenCalledTimes(2)
      expect(persist.mock.calls[1][0].patch.activeTabId).toBe('new')
      expect(persist.mock.calls[1][0].patch).toHaveProperty('activeRepoId')
    }
  )

  it.each(['resolve', 'reject'] as const)(
    'does not resume after disposal and late %s',
    async (outcome) => {
      const { first, persist, onPersistError, wake } = setup()
      useAppStore.setState({ activeTabId: 'new' })
      dispose?.()
      if (outcome === 'resolve') {
        first.resolve()
      } else {
        first.reject(new Error('late failure'))
      }
      wake()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(persist).toHaveBeenCalledTimes(1)
      expect(onPersistError).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('retains a synchronous throw for a later wake', async () => {
    const persist = vi.fn<(write: WorkspaceSessionWrite) => void>().mockImplementationOnce(() => {
      throw new Error('write refused')
    })
    dispose = createSessionWriteSubscriber({ store: useAppStore, persist })
    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'retained'
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(vi.getTimerCount()).toBe(0)
    useAppStore.getState().setCacheTimerStartedAt('tab:pane', Date.now())
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0].patch.activeTabId).toBe('retained')
  })
})
