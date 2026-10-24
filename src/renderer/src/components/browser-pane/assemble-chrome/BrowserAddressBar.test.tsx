// @vitest-environment happy-dom

import { act, type ReactNode, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import BrowserAddressBar from './BrowserAddressBar'

const mocks = vi.hoisted(() => {
  const state: {
    browserUrlHistory: BrowserHistoryEntry[]
    browserDefaultSearchEngine: string | null
    browserKagiSessionLink: string | null
    browserPagesByWorkspace: Record<string, { id: string; worktreeId: string; url: string }[]>
    openPageUrl: string | null
    activateBrowserPage: ReturnType<typeof vi.fn>
    removeBrowserHistoryEntry: ReturnType<typeof vi.fn>
    removeWorkspaceDocHistoryEntry: ReturnType<typeof vi.fn>
    requestBrowserFocus: ReturnType<typeof vi.fn>
  } = {
    browserUrlHistory: [],
    browserDefaultSearchEngine: null,
    browserKagiSessionLink: null,
    browserPagesByWorkspace: {
      'workspace-1': [{ id: 'page-1', worktreeId: 'wt-1', url: 'about:blank' }]
    },
    openPageUrl: null,
    activateBrowserPage: vi.fn(),
    removeBrowserHistoryEntry: vi.fn(),
    removeWorkspaceDocHistoryEntry: vi.fn(),
    requestBrowserFocus: vi.fn()
  }
  return state
})

const OPEN_PAGE_TARGET = { pageId: 'page-2', workspaceId: 'workspace-2', worktreeId: 'wt-1' }

// The worktree's other open pages: one, showing mocks.openPageUrl when set.
vi.mock('@/components/tab-bar/open-tab-search-entries', () => ({
  selectOpenTabSearchBrowserPageState: () => ({
    browserPagesByWorkspace: mocks.browserPagesByWorkspace
  }),
  buildOpenTabSearchBrowserPages: () =>
    mocks.openPageUrl
      ? [
          {
            page: { id: OPEN_PAGE_TARGET.pageId, url: mocks.openPageUrl },
            workspace: { id: OPEN_PAGE_TARGET.workspaceId },
            worktree: { id: OPEN_PAGE_TARGET.worktreeId }
          }
        ]
      : []
}))

vi.mock('@/lib/browser-page-palette-activation', () => ({
  activateBrowserPagePaletteResult: mocks.activateBrowserPage
}))

vi.mock('../host-guest/browser-focus', () => ({ requestBrowserFocus: mocks.requestBrowserFocus }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: typeof mocks) => unknown) => selector(mocks), {
    getState: () => mocks
  })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    value
  }: {
    children: ReactNode
    onSelect?: () => void
    value?: string
  }) => (
    <button data-command-value={value} onClick={onSelect} type="button">
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

function historyEntry(overrides: Partial<BrowserHistoryEntry>): BrowserHistoryEntry {
  return {
    url: 'http://localhost:3000/review-one',
    normalizedUrl: 'http://localhost:3000/review-one',
    title: 'Review one',
    lastVisitedAt: 1_700_000_000_000,
    visitCount: 4,
    ...overrides
  }
}

function typeInto(input: HTMLInputElement, value: string, inputType: string): void {
  // Why the prototype setter: React ignores a value change it did not see through its tracker.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }))
}

function AddressBarHarness({
  initialValue,
  committedValue = initialValue,
  onNavigate,
  onSubmit
}: {
  initialValue: string
  committedValue?: string
  onNavigate: (url: string) => void
  onSubmit: () => void
}): React.ReactElement {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <TooltipProvider>
      <BrowserAddressBar
        pageId="page-1"
        value={value}
        committedValue={committedValue}
        onChange={setValue}
        onSubmit={onSubmit}
        onNavigate={onNavigate}
        inputRef={inputRef}
      />
      <span data-current-address-value="true">{value}</span>
    </TooltipProvider>
  )
}

describe('BrowserAddressBar autocomplete preview', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    mocks.browserUrlHistory = [
      historyEntry({
        url: 'http://localhost:3000/review-one',
        normalizedUrl: 'http://localhost:3000/review-one',
        title: 'Review one'
      })
    ]
    mocks.browserDefaultSearchEngine = null
    mocks.browserKagiSessionLink = null
    mocks.openPageUrl = null
    mocks.activateBrowserPage.mockReturnValue({
      status: 'activated',
      pageId: 'page-2',
      focusTarget: 'webview'
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('restores the typed query when a previewed suggestion is dismissed by blur', async () => {
    const onNavigate = vi.fn()
    const onSubmit = vi.fn()

    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="local" onNavigate={onNavigate} onSubmit={onSubmit} />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    expect(input).not.toBeNull()

    await act(async () => {
      input?.focus()
    })
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'http://localhost:3000/review-one'
    )

    await act(async () => {
      input?.blur()
      vi.advanceTimersByTime(250)
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'local'
    )
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('completes a visited host inline while typing, drops it on Backspace, and submits it on Enter', async () => {
    const onNavigate = vi.fn()
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(<AddressBarHarness initialValue="" onNavigate={onNavigate} onSubmit={onSubmit} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })

    // One key at a time: each keystroke lands on the same completion, which must stay selected.
    for (const typed of ['l', 'lo', 'loc']) {
      await act(async () => typeInto(input, typed, 'insertText'))
    }
    expect(input.value).toBe('localhost:3000')
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 14])

    await act(async () => typeInto(input, 'loc', 'deleteContentBackward'))
    expect(input.value).toBe('loc')

    await act(async () => typeInto(input, 'loca', 'insertText'))
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // Enter goes through the pane's own submit, so its checks apply to completed text too.
    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'localhost:3000'
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('keeps an inline completion the caret has moved past when the bar loses focus', async () => {
    await act(async () => {
      root.render(<AddressBarHarness initialValue="" onNavigate={vi.fn()} onSubmit={vi.fn()} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    await act(async () => typeInto(input, 'loc', 'insertText'))
    await act(async () => {
      // ArrowRight: the caret lands at the end of the completion.
      input.setSelectionRange(14, 14)
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    })
    await act(async () => {
      input.blur()
      vi.advanceTimersByTime(250)
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'localhost:3000'
    )
  })

  it('shows the completion again, tail selected, when arrowing back to its row', async () => {
    await act(async () => {
      root.render(<AddressBarHarness initialValue="" onNavigate={vi.fn()} onSubmit={vi.fn()} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    const typed = 'http://localhost:3000/rev'
    await act(async () => typeInto(input, typed, 'insertText'))
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
      })
    }
    expect(input.value).toBe('http://localhost:3000/review-one')
    expect([input.selectionStart, input.selectionEnd]).toEqual([typed.length, input.value.length])

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(typed)
  })

  it('switches to the tab already showing a suggestion when Tab then Enter picks its button', async () => {
    mocks.openPageUrl = 'http://localhost:3000/review-one'
    const onNavigate = vi.fn()
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="review" onNavigate={onNavigate} onSubmit={onSubmit} />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    for (const key of ['ArrowDown', 'Tab', 'Enter']) {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }

    expect(mocks.activateBrowserPage).toHaveBeenCalledWith(OPEN_PAGE_TARGET)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('lets Enter submit again once Escape has left a focused Switch to tab button', async () => {
    mocks.openPageUrl = 'http://localhost:3000/review-one'
    const onNavigate = vi.fn()
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="review" onNavigate={onNavigate} onSubmit={onSubmit} />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    const press = async (key: string): Promise<void> => {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    await press('ArrowDown')
    await press('Tab')
    await press('Escape')
    await act(async () => {
      input.blur()
      vi.advanceTimersByTime(250)
      input.focus()
    })
    await press('ArrowDown')
    await press('Enter')

    expect(mocks.activateBrowserPage).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('dismisses suggestions when the window blurs', async () => {
    const onNavigate = vi.fn()
    const onSubmit = vi.fn()

    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="local" onNavigate={onNavigate} onSubmit={onSubmit} />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    expect(input).not.toBeNull()

    await act(async () => {
      input?.focus()
    })
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'http://localhost:3000/review-one'
    )

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'local'
    )
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('backs Escape out one step at a time, in Chrome order', async () => {
    await act(async () => {
      root.render(
        <AddressBarHarness
          initialValue="http://localhost:3000/"
          onNavigate={vi.fn()}
          onSubmit={vi.fn()}
        />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')!
    const shown = (): string | null | undefined =>
      container.querySelector('[data-current-address-value="true"]')?.textContent
    const press = async (key: string): Promise<void> => {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    await act(async () => {
      input.focus()
      typeInto(input, 'review', 'insertText')
    })
    await press('ArrowDown')
    expect(shown()).toBe('http://localhost:3000/review-one')

    await press('Escape')
    expect(shown()).toBe('review')
    expect(input.getAttribute('aria-expanded')).toBe('true')

    await press('Escape')
    expect(shown()).toBe('review')
    expect(input.getAttribute('aria-expanded')).toBe('false')

    await press('Escape')
    expect(shown()).toBe('http://localhost:3000/')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, shown()!.length])
    expect(mocks.requestBrowserFocus).not.toHaveBeenCalled()

    await press('Escape')
    expect(mocks.requestBrowserFocus).toHaveBeenCalledWith({ pageId: 'page-1', target: 'webview' })
  })

  it('keeps focus in the bar when the typed text is the page address retyped', async () => {
    await act(async () => {
      root.render(
        <AddressBarHarness
          initialValue="local"
          committedValue="localhost"
          onNavigate={vi.fn()}
          onSubmit={vi.fn()}
        />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')!
    await act(async () => {
      input.focus()
      typeInto(input, 'localhost', 'insertText')
    })
    for (const _ of [1, 2]) {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    }
    expect(mocks.requestBrowserFocus).not.toHaveBeenCalled()
  })

  it('removes the highlighted history row on Shift+Delete and puts back what was typed', async () => {
    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="local" onNavigate={vi.fn()} onSubmit={vi.fn()} />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')!
    await act(async () => {
      input.focus()
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const removal = new KeyboardEvent('keydown', {
      key: 'Delete',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => {
      input.dispatchEvent(removal)
    })

    expect(mocks.removeBrowserHistoryEntry).toHaveBeenCalledWith('http://localhost:3000/review-one')
    expect(removal.defaultPrevented).toBe(true)
    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'local'
    )
  })

  it('leaves Shift+Delete to the text field when the highlighted row is not history', async () => {
    mocks.browserUrlHistory = []
    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="local" onNavigate={vi.fn()} onSubmit={vi.fn()} />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')!
    await act(async () => {
      input.focus()
    })
    const removal = new KeyboardEvent('keydown', {
      key: 'Delete',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => {
      input.dispatchEvent(removal)
    })

    expect(removal.defaultPrevented).toBe(false)
    expect(mocks.removeBrowserHistoryEntry).not.toHaveBeenCalled()
  })

  it('dismisses suggestions when focus moves into an Electron webview guest', async () => {
    const onNavigate = vi.fn()
    const onSubmit = vi.fn()
    const webview = document.createElement('webview')
    document.body.appendChild(webview)

    await act(async () => {
      root.render(
        <AddressBarHarness initialValue="local" onNavigate={onNavigate} onSubmit={onSubmit} />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    expect(input).not.toBeNull()

    await act(async () => {
      input?.focus()
    })
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'http://localhost:3000/review-one'
    )

    await act(async () => {
      webview.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    expect(container.querySelector('[data-current-address-value="true"]')?.textContent).toBe(
      'local'
    )
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('lets the second press of a double-click select a word instead of the whole URL', async () => {
    const url = 'https://github.com/stablyai/orca/pull/27021'
    await act(async () => {
      root.render(<AddressBarHarness initialValue={url} onNavigate={vi.fn()} onSubmit={vi.fn()} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')!

    act(() => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }))
      input.setSelectionRange(url.length, url.length)
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
    })
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, url.length])

    act(() => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2 }))
    })
    // Collapsed, so Chromium's native double-click word selection is not suppressed.
    expect(input.selectionStart).toBe(input.selectionEnd)
  })

  it('clears a selection kept from before blur when a press refocuses the bar', async () => {
    const url = 'https://github.com/stablyai/orca/pull/27021'
    await act(async () => {
      root.render(<AddressBarHarness initialValue={url} onNavigate={vi.fn()} onSubmit={vi.fn()} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')!
    input.setSelectionRange(0, url.length)

    act(() => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }))
    })
    // Collapsed, so the press places a caret and the click can expand it to the whole URL.
    expect(input.selectionStart).toBe(input.selectionEnd)
  })
})
