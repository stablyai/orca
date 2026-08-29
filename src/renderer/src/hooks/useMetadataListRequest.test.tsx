// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMetadataRequestStore } from './metadata-request-cache'
import { useMetadataListRequest } from './useMetadataListRequest'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('useMetadataListRequest', () => {
  it('treats only null as disabled', async () => {
    const store = createMetadataRequestStore<string[]>()
    let loads = 0
    const view = renderHook(() =>
      useMetadataListRequest({
        cacheKey: '',
        store,
        errorFallback: 'Failed to load metadata',
        load: async () => {
          loads += 1
          return ['loaded']
        }
      })
    )

    await act(() => Promise.resolve())
    expect(loads).toBe(1)
    expect(view.result.current.data).toEqual(['loaded'])
  })

  it('ignores stale responses and retains the result while disabled', async () => {
    const store = createMetadataRequestStore<string[]>()
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    const view = renderHook(
      ({ cacheKey }: { cacheKey: string | null }) =>
        useMetadataListRequest({
          cacheKey,
          store,
          errorFallback: 'Failed to load metadata',
          load: () => (cacheKey === 'first' ? first.promise : second.promise)
        }),
      { initialProps: { cacheKey: 'first' as string | null } }
    )

    view.rerender({ cacheKey: 'second' })
    await act(async () => {
      second.resolve(['second'])
      await second.promise
    })
    expect(view.result.current.data).toEqual(['second'])

    view.rerender({ cacheKey: null })
    await act(async () => {
      first.resolve(['first'])
      await first.promise
    })
    expect(view.result.current).toEqual({ data: ['second'], loading: false, error: null })
  })
})
