// @vitest-environment happy-dom

import { act, type ReactNode, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import BrowserAddressBar from './BrowserAddressBar'

const mocks = vi.hoisted(() => ({
  browserUrlHistory: [] as BrowserHistoryEntry[],
  browserDefaultSearchEngine: null as string | null,
  browserKagiSessionLink: null as string | null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks) => unknown) => selector(mocks)
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
})
