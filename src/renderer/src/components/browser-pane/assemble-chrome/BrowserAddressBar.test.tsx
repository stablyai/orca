// @vitest-environment happy-dom

import { act, type ReactNode, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import BrowserAddressBar from './BrowserAddressBar'

const mocks = vi.hoisted(() => {
  const state: {
    browserUrlHistory: BrowserHistoryEntry[]
    browserDefaultSearchEngine: string | null
    browserKagiSessionLink: string | null
    browserPagesByWorkspace: Record<string, { id: string; worktreeId: string; url: string }[]>
    openPageUrl: string | null
    activateBrowserPage: ReturnType<typeof vi.fn>
  } = {
    browserUrlHistory: [],
    browserDefaultSearchEngine: null,
    browserKagiSessionLink: null,
    browserPagesByWorkspace: {
      'workspace-1': [{ id: 'page-1', worktreeId: 'wt-1', url: 'about:blank' }]
    },
    openPageUrl: null,
    activateBrowserPage: vi.fn()
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

vi.mock('../host-guest/browser-focus', () => ({ requestBrowserFocus: vi.fn() }))

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

const COMMITTED_ADDRESS = 'localhost:3000/current'
const noop = (): void => {}

function typeInto(input: HTMLInputElement, value: string, inputType: string): void {
  // Why the prototype setter: React ignores a value change it did not see through its tracker.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }))
}

function AddressBarHarness({
  initialValue,
  onNavigate,
  onSubmit,
  onLeaveAddressBar = noop
}: {
  initialValue: string
  onNavigate: (url: string) => void
  onSubmit: () => void
  onLeaveAddressBar?: () => void
}): React.ReactElement {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <>
      <BrowserAddressBar
        pageId="page-1"
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onNavigate={onNavigate}
        committedAddress={COMMITTED_ADDRESS}
        onLeaveAddressBar={onLeaveAddressBar}
        inputRef={inputRef}
      />
      <span data-current-address-value="true">{value}</span>
    </>
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

  async function renderPreviewingBar(onLeaveAddressBar: () => void): Promise<HTMLInputElement> {
    await act(async () => {
      root.render(
        <AddressBarHarness
          initialValue="local"
          onNavigate={vi.fn()}
          onSubmit={vi.fn()}
          onLeaveAddressBar={onLeaveAddressBar}
        />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    input.setSelectionRange(2, 2)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(input.value).toBe('http://localhost:3000/review-one')
    return input
  }

  async function pressEscape(target: EventTarget, init: KeyboardEventInit = {}): Promise<Event> {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...init
    })
    await act(async () => {
      target.dispatchEvent(event)
    })
    return event
  }

  it('walks Chrome omnibox Escape: restore, close, revert and select, then leave', async () => {
    const onLeaveAddressBar = vi.fn()
    const input = await renderPreviewingBar(onLeaveAddressBar)

    await pressEscape(input)
    expect(input.value).toBe('local')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2])

    await pressEscape(input)
    expect(input.value).toBe('local')
    expect(input.getAttribute('aria-expanded')).toBe('false')

    await pressEscape(input)
    expect(input.value).toBe(COMMITTED_ADDRESS)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, COMMITTED_ADDRESS.length])
    expect(input.selectionDirection).toBe('backward')
    expect(onLeaveAddressBar).not.toHaveBeenCalled()

    await pressEscape(input)
    expect(input.value).toBe(COMMITTED_ADDRESS)
    expect(onLeaveAddressBar).toHaveBeenCalledTimes(1)
  })

  it('reverts an edit that had no dropdown rows with the dropdown closed', async () => {
    mocks.browserUrlHistory = [
      historyEntry({
        url: `http://${COMMITTED_ADDRESS}`,
        normalizedUrl: `http://${COMMITTED_ADDRESS}`,
        title: 'Current'
      })
    ]
    const onLeaveAddressBar = vi.fn()
    await act(async () => {
      root.render(
        <AddressBarHarness
          initialValue="javascript:void"
          onNavigate={vi.fn()}
          onSubmit={vi.fn()}
          onLeaveAddressBar={onLeaveAddressBar}
        />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="option"]')).toBeNull()

    await pressEscape(input)
    expect(input.value).toBe(COMMITTED_ADDRESS)
    expect(input.getAttribute('aria-expanded')).toBe('false')

    await pressEscape(input)
    expect(onLeaveAddressBar).toHaveBeenCalledTimes(1)
  })

  it('consumes Escape so no bubble-phase listener behind the bar handles it', async () => {
    const input = await renderPreviewingBar(vi.fn())
    const bubbleListener = vi.fn()
    window.addEventListener('keydown', bubbleListener)
    try {
      const event = await pressEscape(input)
      expect(event.defaultPrevented).toBe(true)
      expect(bubbleListener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', bubbleListener)
    }
  })

  // Recorded with the macOS Korean IME in Chrome: one Escape mid-syllable fires a marked
  // Escape/229 keydown, then an unmarked Escape/27 one.
  it('closes the dropdown on a composing Escape, ignores its redispatch, then reverts', async () => {
    const onLeaveAddressBar = vi.fn()
    await act(async () => {
      root.render(
        <AddressBarHarness
          initialValue="local"
          onNavigate={vi.fn()}
          onSubmit={vi.fn()}
          onLeaveAddressBar={onLeaveAddressBar}
        />
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[data-orca-browser-address-bar]')
    if (!input) {
      throw new Error('address bar input missing')
    }
    await act(async () => {
      input.focus()
    })
    expect(input.getAttribute('aria-expanded')).toBe('true')

    const marked = await pressEscape(input, { keyCode: 229, isComposing: true })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('local')
    expect(marked.defaultPrevented).toBe(false)

    await pressEscape(input, { keyCode: 27 })
    expect(input.value).toBe('local')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }))
      vi.advanceTimersToNextFrame()
    })
    await pressEscape(input, { keyCode: 27 })
    expect(input.value).toBe(COMMITTED_ADDRESS)
    expect(onLeaveAddressBar).not.toHaveBeenCalled()
  })

  it('leaves a composing Escape over a previewed suggestion to the IME', async () => {
    const onLeaveAddressBar = vi.fn()
    const input = await renderPreviewingBar(onLeaveAddressBar)

    await pressEscape(input, { isComposing: true })

    expect(input.value).toBe('http://localhost:3000/review-one')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(onLeaveAddressBar).not.toHaveBeenCalled()
  })

  it('ignores an Escape that was not typed in the bar', async () => {
    const input = await renderPreviewingBar(vi.fn())

    await pressEscape(window)

    expect(input.value).toBe('http://localhost:3000/review-one')
    expect(input.getAttribute('aria-expanded')).toBe('true')
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
