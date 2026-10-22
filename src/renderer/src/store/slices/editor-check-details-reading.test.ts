import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { readingCheck, readingDetails } from '@/components/editor/check-details-reading-fixture'
import {
  checkDetailsReadingKey,
  checkJobIdentities,
  checkLogDigest,
  checkReadingIntentKey,
  checkReadingLogKey
} from '@/components/editor/check-details-reading-cache'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({ notifyHostOfMirroredEditorClose: vi.fn() }))
vi.mock('@/runtime/gitlab-job-trace-client', () => ({ loadGitLabJobLogDetails: vi.fn() }))

beforeEach(() => scrollTopCache.clear())
afterEach(() => vi.restoreAllMocks())
const id = 'wt-1::check-details::check-run:42'
const context = 'repo:99'
function requestGate() {
  let resolve: (value: ReturnType<typeof readingDetails> | null) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<ReturnType<typeof readingDetails> | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('accepted details requests and reading cache', () => {
  it('limits deliberate error-only intents to five jobs and skips unrequested jobs', () => {
    const store = createEditorTabsStore()
    const first = readingDetails(null, 'error')
    first.jobs = Array.from({ length: 7 }, (_, index) => ({
      ...first.jobs[0],
      id: index + 1,
      name: `synthetic-job-${index}`,
      logState: index === 0 ? 'not_requested' : 'error'
    }))
    store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
      details: first,
      loading: false,
      error: null
    })
    const intents = [...scrollTopCache.keys()].filter((key) => key.includes('::intent:'))
    expect(intents).toHaveLength(5)
    const unclaimed = checkDetailsReadingKey(id, null, context)
    const identities = checkJobIdentities(first.jobs)
    expect(scrollTopCache.has(checkReadingIntentKey(unclaimed, identities[0].identity))).toBe(false)
    expect(scrollTopCache.has(checkReadingIntentKey(unclaimed, identities[6].identity))).toBe(false)
  })
  it.each(['available', 'empty', 'error', 'not_requested', undefined] as const)(
    'seeds first-text intent only for explicit null error, outcome=%s',
    (outcome) => {
      const store = createEditorTabsStore()
      const first = readingDetails(null, outcome)
      store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
        details: first,
        loading: false,
        error: null
      })
      const identity = checkJobIdentities(first.jobs)[0].identity
      const key = checkReadingIntentKey(checkDetailsReadingKey(id, null, context), identity)
      expect(scrollTopCache.has(key)).toBe(outcome === 'error')
    }
  )

  it.each(['empty', 'not_requested', undefined] as const)(
    'retires pending error intent on accepted %s absence without re-arming later text',
    (outcome) => {
      const store = createEditorTabsStore()
      const first = readingDetails(null, 'error')
      store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 0,
        details: first,
        loading: false,
        error: null
      })
      const identity = checkJobIdentities(first.jobs)[0].identity
      const key = checkReadingIntentKey(checkDetailsReadingKey(id, null, context), identity)
      expect(scrollTopCache.get(key)).toBe(-1)
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 1,
        details: readingDetails(null, outcome),
        loading: false,
        error: null
      })
      expect(scrollTopCache.has(key)).toBe(false)
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 2,
        details: readingDetails(undefined, 'available'),
        loading: false,
        error: null
      })
      expect([...scrollTopCache.keys()].some((entry) => entry.includes('::intent:'))).toBe(false)
    }
  )
  it.each(['null', 'throw'])(
    'does not replace a newer completed request after an older %s refresh',
    async (result) => {
      const store = createEditorTabsStore()
      const gate = requestGate()
      store.setState({ fetchPRCheckDetails: vi.fn(() => gate.promise) })
      store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
        details: readingDetails(),
        loading: false,
        error: null
      })
      const refresh = store.getState().reloadOpenCheckRunDetailsTab(id)
      const requestId = (store.getState().openFiles[0].checkRunDetails?.requestId ?? 0) + 1
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId,
        details: readingDetails('Error: newest accepted result'),
        loading: false,
        error: null
      })
      const accepted = store.getState().openFiles[0].checkRunDetails
      const positions = [...scrollTopCache]
      if (result === 'null') {
        gate.resolve(null)
      } else {
        gate.reject(new Error('older failure'))
      }
      await refresh
      expect(store.getState().openFiles[0].checkRunDetails).toBe(accepted)
      expect([...scrollTopCache]).toEqual(positions)
    }
  )
  it.each([false, true])(
    'rejects stale A open/patch around deferred B, omitted epoch=%s',
    async (omitEpoch) => {
      const store = createEditorTabsStore()
      const first = readingDetails(null, 'error')
      const next = readingDetails(undefined, 'available')
      const gate = requestGate()
      const fetch = vi.fn(() => gate.promise)
      store.setState({ fetchPRCheckDetails: fetch })
      const openA = () =>
        store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
          ...(omitEpoch ? {} : { requestId: 0 }),
          details: first,
          loading: false,
          error: null
        })
      store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 0,
        details: first,
        loading: false,
        error: null
      })
      setWithLRU(scrollTopCache, `${checkDetailsReadingKey(id, 'pane', context)}::outer`, 320)
      const refresh = store.getState().reloadOpenCheckRunDetailsTab(id)
      const during = store.getState().openFiles[0].checkRunDetails
      expect(during?.details).toBe(first)
      expect(during?.loading).toBe(true)
      const saved = [...scrollTopCache]
      openA()
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 0,
        details: first,
        loading: false,
        error: 'old'
      })
      expect(store.getState().openFiles[0].checkRunDetails).toBe(during)
      expect([...scrollTopCache]).toEqual(saved)
      await store.getState().reloadOpenCheckRunDetailsTab(id)
      expect(fetch).toHaveBeenCalledTimes(1)
      gate.resolve(next)
      await refresh
      const accepted = store.getState().openFiles[0].checkRunDetails
      openA()
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 0,
        details: first,
        loading: false,
        error: null
      })
      expect(store.getState().openFiles[0].checkRunDetails).toBe(accepted)
      expect(accepted?.details).toBe(next)
      expect(store.getState().activeFileId).toBe(id)
      expect([...scrollTopCache]).toEqual(saved)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['null', 'throw'])(
    'retains the latest accepted same-context payload on %s with a generic message',
    async (result) => {
      const store = createEditorTabsStore()
      const first = readingDetails()
      const latest = readingDetails('Error: more recent accepted content')
      const gate = requestGate()
      store.setState({ fetchPRCheckDetails: vi.fn(() => gate.promise) })
      store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
        details: first,
        loading: false,
        error: null
      })
      const refresh = store.getState().reloadOpenCheckRunDetailsTab(id)
      const requestId = store.getState().openFiles[0].checkRunDetails?.requestId
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId,
        details: latest,
        loading: true,
        error: null
      })
      if (result === 'null') {
        gate.resolve(null)
      } else {
        gate.reject(new Error('SENTINEL_SECRET'))
      }
      await refresh
      const final = store.getState().openFiles[0].checkRunDetails
      expect(final?.details).toBe(latest)
      expect(final?.loading).toBe(false)
      expect(final?.error).toBe(
        result === 'null'
          ? 'No details are available for this check.'
          : 'Failed to load check details.'
      )
      expect(final?.error).not.toContain('SENTINEL_SECRET')
    }
  )

  it('transfers an unmounted pane offset only after accepted text and never re-arms on equal payloads', () => {
    const store = createEditorTabsStore()
    const first = readingDetails()
    store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
      requestId: 2,
      details: first,
      loading: false,
      error: null
    })
    const job = checkJobIdentities(first.jobs)[0].identity
    const owner = checkDetailsReadingKey(id, 'unmounted', context)
    const oldKey = checkReadingLogKey(owner, job, checkLogDigest(first.jobs[0].logTail ?? ''))
    setWithLRU(scrollTopCache, oldKey, 180)
    const changed = readingDetails('Error: next excerpt')
    store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
      requestId: 1,
      details: changed,
      loading: false,
      error: null
    })
    expect(scrollTopCache.get(oldKey)).toBe(180)
    store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
      requestId: 3,
      details: changed,
      loading: false,
      error: null
    })
    const newKey = checkReadingLogKey(owner, job, checkLogDigest(changed.jobs[0].logTail ?? ''))
    expect(scrollTopCache.has(oldKey)).toBe(false)
    expect(scrollTopCache.get(newKey)).toBe(180)
    const keys = [...scrollTopCache]
    store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
      requestId: 3,
      details: { ...changed },
      loading: false,
      error: null
    })
    expect([...scrollTopCache]).toEqual(keys)
  })

  it('discards the superseded post-publication cache transaction under a nested context open', () => {
    const store = createEditorTabsStore()
    let nested = false
    const stop = store.subscribe(() => {
      if (nested) {
        return
      }
      nested = true
      store.getState().openCheckRunDetails('wt-1', 'new-context', readingCheck, {
        details: readingDetails(),
        loading: false,
        error: null
      })
    })
    store.getState().openCheckRunDetails('wt-1', 'old-context', readingCheck, {
      details: null,
      loading: true,
      error: null
    })
    expect(store.getState().openFiles[0].checkRunDetails?.contextKey).toBe('new-context')
    expect([...scrollTopCache.keys()].some((key) => key.includes('old-context'))).toBe(false)
    expect([...scrollTopCache.keys()].some((key) => key.includes('new-context'))).toBe(true)
    stop()
  })

  it('does not write cache state for closed or wrong-context responses', () => {
    const store = createEditorTabsStore()
    store.getState().openCheckRunDetails('wt-1', context, readingCheck, {
      details: null,
      loading: true,
      error: null
    })
    const before = [...scrollTopCache]
    store.getState().patchOpenCheckRunDetails('wt-1', 'wrong', readingCheck, {
      details: readingDetails(),
      loading: false,
      error: null
    })
    expect([...scrollTopCache]).toEqual(before)
    store.setState({ openFiles: [] })
    store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
      details: readingDetails(),
      loading: false,
      error: null
    })
    expect([...scrollTopCache]).toEqual(before)
  })
})
