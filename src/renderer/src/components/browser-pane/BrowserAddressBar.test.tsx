// @vitest-environment happy-dom

import { act, type ReactNode, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../shared/types'
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

function AddressBarHarness({
  initialValue,
  onNavigate,
  onSubmit
}: {
  initialValue: string
  onNavigate: (url: string) => void
  onSubmit: () => void
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
})
