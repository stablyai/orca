import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'
import { debouncedSaveCache } from './cache-persistence'

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

it('releases unrelated discarded renderer state while the cache save is pending', async () => {
  const store = createTestStore()
  const schedule = () => {
    const drafts = { closedFile: Buffer.alloc(8 * 1024 * 1024, 65).toString('utf8') }
    const state = { ...store.getState(), editorDrafts: drafts }
    debouncedSaveCache(state)
    return { state: new WeakRef(state), drafts: new WeakRef(drafts) }
  }
  const discarded = schedule()
  if (!global.gc) {
    throw new Error('config/vitest.config.ts must pass --expose-gc')
  }
  for (let turn = 0; turn < 3; turn += 1) {
    await setImmediate()
    global.gc()
  }

  expect(setGitHub).not.toHaveBeenCalled()
  expect(discarded.state.deref() === undefined).toBe(true)
  expect(discarded.drafts.deref() === undefined).toBe(true)
  vi.advanceTimersByTime(1000)
  expect(setGitHub).toHaveBeenCalledOnce()
})

it('persists the latest requested cache maps once after the trailing second', () => {
  const state = createTestStore().getState()
  const first = { ...state, prCache: {}, issueCache: {} }
  const latest = { ...state, prCache: {}, issueCache: {} }
  debouncedSaveCache(first)
  vi.advanceTimersByTime(999)
  expect(setGitHub).not.toHaveBeenCalled()

  debouncedSaveCache(latest)
  vi.advanceTimersByTime(999)
  expect(setGitHub).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(setGitHub).toHaveBeenCalledOnce()
  expect(setGitHub.mock.calls[0][0]).toEqual({
    cache: { pr: latest.prCache, issue: latest.issueCache }
  })
  expect(setGitHub.mock.calls[0][0].cache.pr).toBe(latest.prCache)
  expect(setGitHub.mock.calls[0][0].cache.issue).toBe(latest.issueCache)
  vi.advanceTimersByTime(1000)
  expect(setGitHub).toHaveBeenCalledOnce()
})
