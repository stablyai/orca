// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { makeAnnotation } from '@/store/slices/browser/annotations/browser-annotation-test-fixture'
import { useHeldGrabPick } from './use-held-grab-pick'

const picked: BrowserGrabPayload = { ...makeAnnotation('page-1').payload, screenshot: null }
// The page as main reports it: which selectors still match an element.
let presentInPage = new Set<string>()

beforeEach(() => {
  presentInPage = new Set([picked.target.selector])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        grabSelectorPresent: async ({ selector }: { selector: string }) =>
          presentInPage.has(selector)
      }
    }
  })
})

type Props = { state: 'confirming' | 'armed'; url: string }
const FIRST: Props = { state: 'confirming', url: 'http://acme.test/' }

function renderHeld() {
  return renderHook(
    ({ state, url }: Props) =>
      useHeldGrabPick({
        grab: { state, payload: state === 'confirming' ? picked : null },
        grabIntent: 'copy',
        activeTool: 'copy',
        owner: 'page-1\ndoc\n0',
        pageId: 'page-1',
        currentUrl: url
      }),
    { initialProps: FIRST }
  )
}

describe('the held Grab pick across a same-document route change', () => {
  it('stays while its element is still in the page', async () => {
    const { result, rerender } = renderHeld()
    rerender({ state: 'armed', url: 'http://acme.test/' })
    expect(result.current).toBe(picked)

    rerender({ state: 'armed', url: 'http://acme.test/#pricing' })
    await act(async () => {})

    expect(result.current).toBe(picked)
  })

  it('ends when the route change removed its element', async () => {
    const { result, rerender } = renderHeld()
    rerender({ state: 'armed', url: 'http://acme.test/' })
    presentInPage.clear()

    rerender({ state: 'armed', url: 'http://acme.test/plans' })
    await act(async () => {})

    expect(result.current).toBeNull()
  })
})
