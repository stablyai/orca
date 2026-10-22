import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'
import { persistGitHubCacheChanges } from './cache-persistence'

const setGitHub = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  setGitHub.mockReset()
  vi.stubGlobal('window', { api: { cache: { setGitHub } } })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const prEntry = (fetchedAt: number) => ({ data: null, fetchedAt })

it('writes main within a second of a change, never before one', () => {
  const store = createTestStore()
  persistGitHubCacheChanges(store)
  vi.advanceTimersByTime(5000)
  expect(setGitHub).not.toHaveBeenCalled()

  store.setState({ prCache: { a: prEntry(1) } })
  vi.advanceTimersByTime(999)
  // A later change rides the open window instead of pushing the write back.
  store.setState({ prCache: { a: prEntry(2) } })
  vi.advanceTimersByTime(1)
  expect(setGitHub).toHaveBeenCalledOnce()
  expect(setGitHub.mock.calls[0][0].cache.pr).toBe(store.getState().prCache)
  expect(setGitHub.mock.calls[0][0].cache.issue).toBe(store.getState().issueCache)
})

it('ignores state that is not a GitHub cache and installs once per store', () => {
  const store = createTestStore()
  persistGitHubCacheChanges(store)
  persistGitHubCacheChanges(store)

  store.setState({ checksCache: {} })
  vi.advanceTimersByTime(1000)
  expect(setGitHub).not.toHaveBeenCalled()

  store.setState({ issueCache: {} })
  vi.advanceTimersByTime(1000)
  expect(setGitHub).toHaveBeenCalledOnce()
})
