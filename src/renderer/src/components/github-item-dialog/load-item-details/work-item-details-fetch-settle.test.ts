import { afterEach, expect, it } from 'vitest'
import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import {
  workItemDetailsCache,
  touchWorkItemDetailsCache,
  patchCachedWorkItemBody,
  patchCachedPRChecks,
  patchCachedPRReviewRequests,
  patchCachedPRFileViewedState
} from './work-item-details-cache'
import { settleWorkItemDetailsFetch } from './work-item-details-fetch-settle'

const details: GitHubWorkItemDetails = {
  item: {
    id: 'issue:5',
    type: 'issue',
    number: 5,
    url: 'https://github.com/o/r/issues/5',
    title: 'Retained',
    state: 'open',
    labels: [],
    author: null,
    updatedAt: ''
  },
  body: 'Keep body',
  comments: []
}
afterEach(() => workItemDetailsCache.clear())

it.each([false, true])(
  'a replaced request cannot overwrite or clear newer pending data (rejection=%s)',
  async (reject) => {
    let finish: () => void = () => {}
    const old = new Promise<GitHubWorkItemDetails | null>((resolve, rejectPromise) => {
      finish = () => (reject ? rejectPromise(new Error('Old failure')) : resolve(details))
    })
    touchWorkItemDetailsCache('key', { details, fetchedAt: 10, pending: old })
    const settling = settleWorkItemDetailsFetch({ detailsCacheKey: 'key', inflight: old })
    const newer = new Promise<GitHubWorkItemDetails | null>(() => {})
    const entry = { details, fetchedAt: 20, pending: newer }
    touchWorkItemDetailsCache('key', entry)
    finish()
    expect(await settling).toEqual({ status: 'superseded' })
    expect(workItemDetailsCache.get('key')).toBe(entry)
  }
)

it('clears only its owned pending request when captured context no longer accepts it', async () => {
  const inflight = Promise.resolve(details)
  touchWorkItemDetailsCache('key', { details, fetchedAt: 10, pending: inflight })
  expect(
    await settleWorkItemDetailsFetch({ detailsCacheKey: 'key', inflight, accepts: () => false })
  ).toEqual({ status: 'superseded' })
  expect(workItemDetailsCache.get('key')).toEqual({ details, fetchedAt: 10, pending: undefined })
})

it.each([null, new Error('Read failed')])(
  'retains prior details after whole-read failure and accepts a retry: %s',
  async (failure) => {
    const inflight = failure ? Promise.reject(failure) : Promise.resolve(null)
    touchWorkItemDetailsCache('key', { details, fetchedAt: 10, pending: inflight })
    expect((await settleWorkItemDetailsFetch({ detailsCacheKey: 'key', inflight })).status).toBe(
      'failed'
    )
    expect(workItemDetailsCache.get('key')).toMatchObject({ details, fetchedAt: 10 })
    expect(workItemDetailsCache.get('key')?.pending).toBeUndefined()
    const returned = { ...details, body: 'Returned' }
    const retry = Promise.resolve(returned)
    touchWorkItemDetailsCache('key', {
      ...workItemDetailsCache.get('key'),
      details,
      fetchedAt: 10,
      pending: retry
    })
    expect(await settleWorkItemDetailsFetch({ detailsCacheKey: 'key', inflight: retry })).toEqual({
      status: 'accepted',
      details: returned
    })
    expect(workItemDetailsCache.get('key')?.details).toBe(returned)
  }
)

it('keeps ordinary PR partial writers on the same exact lease until a useful full result settles', async () => {
  const request = Promise.withResolvers<GitHubWorkItemDetails | null>()
  const pr: GitHubWorkItemDetails = {
    ...details,
    item: { ...details.item, type: 'pr' as const },
    files: [
      {
        path: 'file.ts',
        additions: 0,
        deletions: 0,
        isBinary: false,
        status: 'modified',
        viewerViewedState: 'UNVIEWED' as const
      }
    ]
  }
  touchWorkItemDetailsCache('pr', { details: pr, fetchedAt: 10, pending: request.promise })
  const settling = settleWorkItemDetailsFetch({ detailsCacheKey: 'pr', inflight: request.promise })
  patchCachedWorkItemBody('pr', 'Partial body')
  patchCachedPRChecks('pr', [])
  patchCachedPRReviewRequests('pr', [])
  patchCachedPRFileViewedState('pr', 'file.ts', 'VIEWED')
  expect(workItemDetailsCache.get('pr')?.pending).toBe(request.promise)
  request.resolve({ ...pr, item: { ...pr.item, title: 'Useful full title' } })
  expect((await settling).status).toBe('accepted')
  expect(workItemDetailsCache.get('pr')?.details?.item.title).toBe('Useful full title')
})
