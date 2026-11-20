// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeAnnotation } from '@/store/slices/browser/annotations/browser-annotation-test-fixture'
import { useHeldGrabPick } from './use-held-grab-pick'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('retains a live pick on an unavailable check and drops it only when a later check establishes absence', async () => {
  const payload = makeAnnotation('page').payload
  let finish: ((present: boolean | null) => void) | undefined
  const pending = new Promise<boolean | null>((resolve) => {
    finish = resolve
  })
  let query = () => pending
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: { grabPickedElementPresent: () => query() }
    }
  })
  const { result, rerender } = renderHook(
    ({ url }) =>
      useHeldGrabPick({
        grab: { state: 'confirming', payload },
        grabIntent: 'copy',
        activeTool: 'copy',
        owner: 'page-generation',
        pageId: 'page',
        currentUrl: url
      }),
    { initialProps: { url: 'https://synthetic.test/' } }
  )
  expect(result.current).toBe(payload)
  rerender({ url: 'https://synthetic.test/#route' })
  await act(async () => {
    finish?.(null)
  })
  expect(result.current).toBe(payload)
  query = () => Promise.resolve(false)
  rerender({ url: 'https://synthetic.test/#later' })
  await waitFor(() => expect(result.current).toBeNull())
})
