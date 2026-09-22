// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'
import { createTestStore } from '@/store/slices/browser-slice-test-harness'
import type { OpenAgentSendPopoverTargetModeArgs } from '@/store/slices/ui'
import { BrowserPageAnnotationTray } from './browser-page-annotation-tray'
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
vi.mock('./BrowserAnnotationSendMenuContent', () => ({
  BrowserAnnotationSendMenuContent: ({ onPromptDelivered }: { onPromptDelivered?: () => void }) => (
    <button onClick={onPromptDelivered}>Complete delivery</button>
  )
}))

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
let mode: OpenAgentSendPopoverTargetModeArgs | undefined

beforeEach(() => {
  store = createTestStore()
  state.store = store
  mode = undefined
  store.setState({
    activeGroupIdByWorktree: {},
    openAgentSendPopoverTargetMode: (next) => {
      mode = next
    },
    closeAgentSendPopoverTargetMode: vi.fn()
  })
  store.getState().addBrowserPageAnnotation(makeAnnotation('page-1'))
  store.getState().addBrowserPageAnnotation(makeAnnotation('page-2', 'other'))
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

function AnnotationTrayHarness(): React.JSX.Element | null {
  const annotationSend = useBrowserPageAnnotationSend({
    browserTabId: 'page-1',
    worktreeId: 'folder-1'
  })
  if (annotationSend.browserAnnotations.length === 0) {
    return null
  }
  return (
    <TooltipProvider>
      <BrowserPageAnnotationTray {...annotationSend} annotationTraySendOpen worktreeId="folder-1" />
    </TooltipProvider>
  )
}

describe('website annotation delivery', () => {
  it('removes the annotation tray only after its prompt is delivered', () => {
    render(<AnnotationTrayHarness />)

    expect(screen.getByText('Fix this button')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Complete delivery' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Complete delivery' }))

    expect(screen.queryByText('Fix this button')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Complete delivery' })).not.toBeInTheDocument()
    expect(notes('page-2')).toHaveLength(1)
  })

  it.each(['banner', 'tray'] as const)(
    'captures the %s sidebar prompt and keeps later edits and additions',
    (surface) => {
      store.getState().addBrowserPageAnnotation(makeAnnotation('page-1', 'unchanged'))
      const view = mount()
      act(() => {
        if (surface === 'banner') {
          view.result.current.handleAnnotationBannerSendOpenChange(true)
        } else {
          view.result.current.handleAnnotationTraySendOpenChange(true)
        }
      })
      const delivery = mode
      expect(delivery?.prompt).toContain('Fix this button')
      expect(delivery?.onPromptDelivered).toBeTypeOf('function')
      act(() => {
        store.getState().updateBrowserPageAnnotation('page-1', 'annotation-1', {
          comment: 'New edit',
          intent: 'change'
        })
        store.getState().addBrowserPageAnnotation(makeAnnotation('page-1', 'new'))
      })
      act(() => delivery?.onPromptDelivered?.())
      expect(notes().map((note) => note.id)).toEqual(['annotation-1', 'new'])
      expect(notes()[0].comment).toBe('New edit')
      act(() => delivery?.onPromptDelivered?.())
      expect(notes()).toHaveLength(2)
    }
  )

  it('preserves later notes when a menu send finishes after unmount', () => {
    const view = mount()
    const delivered = view.result.current.handleBrowserAnnotationsSentToAgent
    act(() => store.getState().addBrowserPageAnnotation(makeAnnotation('page-1', 'new')))
    view.unmount()
    act(delivered)
    expect(notes().map((note) => note.id)).toEqual(['new'])
  })

  it('keeps copied notes until delivery is acknowledged', () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
    const view = mount()
    act(() => view.result.current.handleCopyBrowserAnnotations())
    expect(writeClipboardText).toHaveBeenCalledWith(view.result.current.browserAnnotationsPrompt)
    expect(notes()).toHaveLength(1)
  })

  it('does not erase replacement notes after a navigation clears the original page', () => {
    const view = mount()
    const delivered = view.result.current.handleBrowserAnnotationsSentToAgent
    act(() => {
      store.getState().clearBrowserPageAnnotations('page-1')
      store.getState().addBrowserPageAnnotation(makeAnnotation('page-1'))
    })
    act(delivered)
    expect(notes()).toHaveLength(1)
  })

  it('preserves notes when a picker closes without delivery and still supports Clear all', () => {
    const view = mount()
    act(() => view.result.current.handleAnnotationTraySendOpenChange(true))
    act(() => view.result.current.handleAnnotationTraySendOpenChange(false))
    expect(notes()).toHaveLength(1)
    act(() => view.result.current.handleClearBrowserAnnotations())
    expect(notes()).toEqual([])
  })
})
