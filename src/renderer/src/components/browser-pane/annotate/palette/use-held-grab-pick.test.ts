// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { syntheticGrabPayload } from '../testing/synthetic-grab-payload.fixture'
import { useHeldGrabPick } from './use-held-grab-pick'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('retains a live pick on an unavailable check and drops it only when a later check establishes absence', async () => {
  const payload = syntheticGrabPayload()
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
  const { result } = renderHook(
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
  expect(result.current.payload).toBe(payload)
  await act(async () => {
    finish?.(null)
  })
  expect(result.current.payload).toBe(payload)
  query = () => Promise.resolve(false)
  await waitFor(() => expect(result.current.payload).toBeNull())
})

it('keeps one presence check outstanding across a same-document URL change', async () => {
  const payload = syntheticGrabPayload()
  let answer: ((present: boolean | null) => void) | undefined
  let checks = 0
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        grabPickedElementPresent: () => {
          checks += 1
          return new Promise<boolean | null>((resolve) => {
            answer = resolve
          })
        }
      }
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
  await waitFor(() => expect(checks).toBe(1))
  rerender({ url: 'https://synthetic.test/#section' })
  rerender({ url: 'https://synthetic.test/other' })
  expect(checks).toBe(1)
  await act(async () => {
    answer?.(false)
  })
  expect(result.current.payload).toBeNull()
})
