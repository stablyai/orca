// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItemDetails } from '../../../shared/types'
import {
  WORK_ITEM_DETAILS_CACHE_MAX,
  WORK_ITEM_DETAILS_CACHE_MAX_KEY_BYTES,
  WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES,
  clearWorkItemDetailsCacheForTests,
  createWorkItemDetailsCacheController,
  getWorkItemDetailsCacheEntry,
  getWorkItemDetailsCacheGeneration,
  getWorkItemDetailsCacheKey,
  invalidateWorkItemDetailsCacheByMatch,
  invalidateWorkItemDetailsCacheForKey,
  touchWorkItemDetailsCache,
  useWorkItemDetailsCacheEntry,
  type WorkItemDetailsCacheEntry
} from './github-work-item-details-cache'
import { measureWorkItemDetailsCacheEntryBytes } from './github-work-item-details-retained-bytes'

function details(body = ''): GitHubWorkItemDetails {
  return {
    item: {
      id: 'issue-1',
      type: 'issue',
      number: 1,
      title: 'Issue',
      state: 'open',
      url: 'https://github.com/acme/repo/issues/1',
      labels: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      author: 'octocat'
    },
    body,
    comments: []
  }
}

function entry(body = ''): WorkItemDetailsCacheEntry {
  return { details: details(body), fetchedAt: 1 }
}

function entryBytes(value: WorkItemDetailsCacheEntry, maxBytes = 1_000_000): number {
  const measured = measureWorkItemDetailsCacheEntryBytes(value, maxBytes)
  if (measured === null) {
    throw new Error('Fixture exceeded its measurement limit')
  }
  return measured
}

afterEach(() => {
  clearWorkItemDetailsCacheForTests()
  document.body.replaceChildren()
})

describe('work-item details cache controller', () => {
  it('retains a settled value exactly at the production limit', () => {
    const controller = createWorkItemDetailsCacheController()
    const baseBytes = entryBytes(entry(), WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES)
    const exact = entry('x'.repeat(WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES - baseBytes))

    expect(
      measureWorkItemDetailsCacheEntryBytes(exact, WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES)
    ).toBe(WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES)
    expect(controller.set('exact', exact)).toBe(true)
    expect(controller.get('exact')).toBe(exact)
  })

  it('rejects one byte over the value limit and removes the stale entry', () => {
    const maxValueBytes = 512
    const controller = createWorkItemDetailsCacheController({
      maxValueBytes,
      maxAggregateBytes: 2_000
    })
    const baseBytes = entryBytes(entry(), maxValueBytes)
    const exact = entry('x'.repeat(maxValueBytes - baseBytes))
    const over = entry('x'.repeat(maxValueBytes - baseBytes + 1))

    expect(controller.set('key', exact)).toBe(true)
    expect(controller.set('key', over)).toBe(false)
    expect(controller.get('key')).toBeUndefined()
    expect(controller.getRetainedBytes()).toBe(0)
  })

  it('measures the 4 KiB key limit in UTF-8 bytes', () => {
    const controller = createWorkItemDetailsCacheController({
      maxKeyBytes: WORK_ITEM_DETAILS_CACHE_MAX_KEY_BYTES
    })
    const exactKey = '😀'.repeat(WORK_ITEM_DETAILS_CACHE_MAX_KEY_BYTES / 4)
    const oversizedKey = `${exactKey}a`

    expect(controller.set(exactKey, entry())).toBe(true)
    expect(controller.set(oversizedKey, entry())).toBe(false)
    expect(controller.get(exactKey)).toBeDefined()
    expect(controller.get(oversizedKey)).toBeUndefined()
  })

  it('globally evicts the least-recently-used settled entry under aggregate pressure', () => {
    const value = entry('payload')
    const retainedValueBytes = entryBytes(value)
    const controller = createWorkItemDetailsCacheController({
      maxAggregateBytes: 2 * (retainedValueBytes + 1),
      maxValueBytes: retainedValueBytes
    })

    controller.set('a', value)
    controller.set('b', value)
    expect(controller.getRetainedBytes()).toBe(2 * (retainedValueBytes + 1))
    expect(controller.get('a')).toBe(value)
    controller.set('c', value)

    expect(controller.get('a')).toBe(value)
    expect(controller.get('b')).toBeUndefined()
    expect(controller.get('c')).toBe(value)
  })

  it('keeps pending promises count-bounded without measuring the promise object', () => {
    const controller = createWorkItemDetailsCacheController()
    const pending = Promise.resolve<GitHubWorkItemDetails | null>(null)

    for (let index = 0; index <= WORK_ITEM_DETAILS_CACHE_MAX; index += 1) {
      expect(
        controller.set(`pending-${index}`, {
          details: null,
          fetchedAt: 0,
          pending
        })
      ).toBe(true)
    }

    expect(controller.getSize()).toBe(WORK_ITEM_DETAILS_CACHE_MAX)
    expect(controller.get('pending-0')).toBeUndefined()
    expect(controller.get(`pending-${WORK_ITEM_DETAILS_CACHE_MAX}`)?.pending).toBe(pending)
  })

  it('releases aggregate accounting when matching entries are invalidated', () => {
    const controller = createWorkItemDetailsCacheController()
    controller.set('repo-a\u0000auto\u0000issue\u00001', entry('first'))
    controller.set('repo-b\u0000auto\u0000issue\u00001', entry('second'))
    const retainedBefore = controller.getRetainedBytes()

    expect(controller.deleteMatching((key) => key.startsWith('repo-a\u0000'))).toEqual([
      'repo-a\u0000auto\u0000issue\u00001'
    ])
    expect(controller.getRetainedBytes()).toBeLessThan(retainedBefore)
    controller.clear()
    expect(controller.getRetainedBytes()).toBe(0)
  })
})

describe('shared work-item details cache', () => {
  it('preserves exact-key and match invalidation generation semantics', () => {
    const key = getWorkItemDetailsCacheKey({
      repoPath: '/repo',
      repoId: 'repo-1',
      issueSourcePreference: undefined,
      type: 'issue',
      number: 1
    })
    touchWorkItemDetailsCache(key, entry())
    const initialGeneration = getWorkItemDetailsCacheGeneration()

    invalidateWorkItemDetailsCacheByMatch({
      repoPath: '/repo',
      repoId: 'repo-1',
      type: 'issue',
      number: 1
    })
    expect(getWorkItemDetailsCacheGeneration()).toBe(initialGeneration + 1)
    expect(getWorkItemDetailsCacheEntry(key)).toBeUndefined()

    invalidateWorkItemDetailsCacheForKey(key)
    expect(getWorkItemDetailsCacheGeneration()).toBe(initialGeneration + 2)
  })

  it('renders an oversized result only while its consumer remains mounted', () => {
    const key = 'mounted'
    const oversized = entry('x'.repeat(WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    function Probe(): React.JSX.Element {
      const cached = useWorkItemDetailsCacheEntry(key)
      return createElement('span', null, cached?.details?.body.length ?? 'missing')
    }

    act(() => root.render(createElement(Probe)))
    act(() => {
      expect(touchWorkItemDetailsCache(key, oversized)).toBe(false)
    })

    expect(container.textContent).toBe(String(oversized.details?.body.length))
    expect(getWorkItemDetailsCacheEntry(key)).toBeUndefined()

    act(() => root.unmount())
    const remountedRoot: Root = createRoot(container)
    act(() => remountedRoot.render(createElement(Probe)))
    expect(container.textContent).toBe('missing')
    act(() => remountedRoot.unmount())
  })
})
