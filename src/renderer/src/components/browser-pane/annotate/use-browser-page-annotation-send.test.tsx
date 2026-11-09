// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'
import { createTestStore } from '@/store/slices/browser/browser-slice-test-harness'

import { useBrowserPageAnnotationSend } from './use-browser-page-annotation-send'

const state = vi.hoisted((): { store?: ReturnType<typeof createTestStore> } => ({}))
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (value: ReturnType<ReturnType<typeof createTestStore>['getState']>) => unknown
  ) => {
    if (!state.store) {
      throw new Error('Missing test store')
    }
    return state.store(selector)
  }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function makeAnnotation(pageId: string, id = 'annotation-1'): BrowserPageAnnotation {
  return {
    id,
    browserPageId: pageId,
    comment: 'Fix this button',
    intent: 'fix',
    priority: 'important',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com',
        title: 'Example',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-05-15T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: 'button',
        textSnippet: 'Submit',
        htmlSnippet: '<button>Submit</button>',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: 'Submit',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 0, y: 0, width: 100, height: 40 },
        rectPage: { x: 0, y: 0, width: 100, height: 40 },
        computedStyles: {
          display: 'inline-flex',
          position: 'static',
          width: '100px',
          height: '40px',
          margin: '0px',
          padding: '0px',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          border: '0px none',
          borderRadius: '0px',
          fontFamily: 'Geist',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  store = createTestStore()
  state.store = store
  store.setState({
    closeAgentSendPopoverTargetMode: vi.fn()
  })
  store.getState().addBrowserPageAnnotation(makeAnnotation('page-1'))
})
afterEach(cleanup)

function mount() {
  return renderHook(() =>
    useBrowserPageAnnotationSend({ browserTabId: 'page-1', worktreeId: 'folder-1' })
  )
}
function notes(page = 'page-1') {
  return store.getState().browserAnnotationsByPageId[page] ?? []
}

describe('website annotations handed to a send', () => {
  const second = (): BrowserPageAnnotation => ({
    ...makeAnnotation('page-1', 'second'),
    comment: 'Second note'
  })

  it('sends only an annotation added while an earlier send is still on its way', async () => {
    const view = mount()
    const firstDelivered = view.result.current.handleBrowserAnnotationsSentToAgent
    let deliverFirst!: (result: { delivered: boolean }) => void
    act(() =>
      view.result.current.handleBrowserAnnotationsHandedOff(
        new Promise((resolve) => (deliverFirst = resolve))
      )
    )
    expect(view.result.current.browserAnnotationsPrompt).toBe('')

    act(() => store.getState().addBrowserPageAnnotation(second()))
    expect(view.result.current.browserAnnotationsPrompt).toContain('Second note')
    expect(view.result.current.browserAnnotationsPrompt).not.toContain('Fix this button')
    const secondDelivered = view.result.current.handleBrowserAnnotationsSentToAgent

    act(firstDelivered)
    await act(async () => deliverFirst({ delivered: true }))
    expect(notes().map((note) => note.id)).toEqual(['second'])
    act(secondDelivered)
    expect(notes()).toEqual([])
  })
})
