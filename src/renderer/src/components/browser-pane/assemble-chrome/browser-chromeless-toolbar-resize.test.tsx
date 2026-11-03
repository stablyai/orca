// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { buildBrowserPage } from '@/store/slices/browser-page-records'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'

const page = buildBrowserPage(
  'workspace-1',
  'wt-1',
  'https://example.com',
  'Example',
  null,
  'page-1'
)
let narrow = false
const observers = new Set<() => void>()

beforeEach(() => {
  narrow = false
  observers.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(): void {
        observers.add(this.callback)
      }
      disconnect(): void {
        observers.delete(this.callback)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ width: narrow ? 0 : 500 })
  )
  useAppStore.setState({
    browserPagesByWorkspace: { [page.workspaceId]: [{ ...page, chromeless: true }] }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('restoring a chromeless adaptive toolbar', () => {
  it('keeps tools responsive to resize after initial creation and subsequent restores', () => {
    render(
      <TooltipProvider>
        <BrowserChromeToolbar
          browserPageId={page.id}
          controls={{
            canGoBack: false,
            canGoForward: false,
            goBack: vi.fn(),
            goForward: vi.fn(),
            reload: vi.fn(),
            navigate: vi.fn()
          }}
          addressSlot={<input aria-label="Address" />}
          elementTools={null}
          markup={{ active: false, disabled: true, onToggle: vi.fn(), canShowDiscoveryHint: false }}
          viewSource={null}
          openExternal={{ label: 'Open external', onSelect: vi.fn() }}
          overflowMenu={({ tools }) => <button>Menu {tools.map((t) => t.label).join(', ')}</button>}
        />
      </TooltipProvider>
    )
    expect(screen.queryByLabelText('Address')).toBeNull()

    for (let restore = 0; restore < 2; restore++) {
      narrow = false
      act(() => useAppStore.getState().setBrowserPageChromeless(page.id, false))
      expect(screen.getByRole('button', { name: 'Open external' })).toBeTruthy()
      act(() => {
        narrow = true
        observers.forEach((callback) => callback())
      })
      expect(screen.queryByRole('button', { name: 'Open external' })).toBeNull()
      expect(screen.getByRole('button', { name: /Menu.*Open external/ })).toBeTruthy()
      act(() => useAppStore.getState().setBrowserPageChromeless(page.id, true))
      expect(screen.queryByLabelText('Address')).toBeNull()
    }
  })
})
