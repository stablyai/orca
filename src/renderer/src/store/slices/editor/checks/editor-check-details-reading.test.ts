import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '../editor-slice-test-harness'
import {
  readingCheck,
  readingDetails
} from '@/components/editor/check-details/reading/check-details-reading-fixture'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/web-session-tabs-sync/closing/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))
vi.mock('@/runtime/repository-gitlab/gitlab-job-trace-client', () => ({
  loadGitLabJobLogDetails: vi.fn()
}))

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
      if (result === 'null') {
        gate.resolve(null)
      } else {
        gate.reject(new Error('older failure'))
      }
      await refresh
      expect(store.getState().openFiles[0].checkRunDetails).toBe(accepted)
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
      const refresh = store.getState().reloadOpenCheckRunDetailsTab(id)
      const during = store.getState().openFiles[0].checkRunDetails
      expect(during?.details).toBe(first)
      expect(during?.loading).toBe(true)
      openA()
      store.getState().patchOpenCheckRunDetails('wt-1', context, readingCheck, {
        requestId: 0,
        details: first,
        loading: false,
        error: 'old'
      })
      expect(store.getState().openFiles[0].checkRunDetails).toBe(during)
      await store.getState().reloadOpenCheckRunDetailsTab(id)
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
      expect(final?.error).not.toContain('SENTINEL_SECRET')
    }
  )

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
    stop()
  })
})
