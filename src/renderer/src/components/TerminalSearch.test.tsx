// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchAddon } from '@xterm/addon-search'
import type { IEvent, IDisposable } from '@xterm/xterm'
import TerminalSearch from './TerminalSearch'
import type { SearchState } from '@/components/terminal-pane/keyboard-handlers'

type ResultsEvent = { resultIndex: number; resultCount: number }

/**
 * Minimal SearchAddon stub exposing a controllable onDidChangeResults emitter.
 * The match-count indicator is driven entirely by that event, so the stub lets
 * tests push result payloads without a real xterm buffer.
 */
function makeSearchAddonStub(): {
  addon: SearchAddon
  emit: (payload: ResultsEvent) => void
  disposeSpy: ReturnType<typeof vi.fn>
} {
  let listener: ((payload: ResultsEvent) => void) | null = null
  const disposeSpy = vi.fn(() => {
    listener = null
  })
  const onDidChangeResults: IEvent<ResultsEvent> = (handler) => {
    listener = handler as (payload: ResultsEvent) => void
    return { dispose: disposeSpy } as IDisposable
  }
  const addon = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
    onDidChangeResults
  } as unknown as SearchAddon

  return {
    addon,
    emit: (payload) => {
      act(() => {
        listener?.(payload)
      })
    },
    disposeSpy
  }
}

function renderSearch(
  addon: SearchAddon,
  query: string
): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const searchStateRef = { current: { query: '', caseSensitive: false, regex: false } as SearchState }
  act(() => {
    root.render(
      <TerminalSearch
        isOpen
        onClose={() => {}}
        searchAddon={addon}
        searchStateRef={searchStateRef}
      />
    )
  })
  if (query) {
    const input = container.querySelector('input') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { root, container }
}

function statusText(container: HTMLElement): string {
  const spans = Array.from(container.querySelectorAll('span'))
  return spans.map((s) => s.textContent?.trim()).find((t) => t && /\/|results|\+/.test(t)) ?? ''
}

describe('TerminalSearch match-count indicator', () => {
  let root: Root | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.innerHTML = ''
  })

  it('renders 0/0 for an empty query', () => {
    const { addon } = makeSearchAddonStub()
    const rendered = renderSearch(addon, '')
    root = rendered.root
    expect(statusText(rendered.container)).toBe('0/0')
  })

  it('renders current/total after a results event', () => {
    const stub = makeSearchAddonStub()
    const rendered = renderSearch(stub.addon, 'foo')
    root = rendered.root
    stub.emit({ resultIndex: 2, resultCount: 12 })
    expect(statusText(rendered.container)).toBe('3/12')
  })

  it('renders "No results" for a non-empty query with zero matches', () => {
    const stub = makeSearchAddonStub()
    const rendered = renderSearch(stub.addon, 'foo')
    root = rendered.root
    stub.emit({ resultIndex: -1, resultCount: 0 })
    expect(statusText(rendered.container)).toBe('No results')
  })

  it('renders <count>+ when the match threshold is exceeded (resultIndex -1, count > 0)', () => {
    const stub = makeSearchAddonStub()
    const rendered = renderSearch(stub.addon, 'foo')
    root = rendered.root
    stub.emit({ resultIndex: -1, resultCount: 1000 })
    expect(statusText(rendered.container)).toBe('1000+')
  })

  it('disposes the results subscription on unmount', () => {
    const stub = makeSearchAddonStub()
    const rendered = renderSearch(stub.addon, 'foo')
    act(() => rendered.root.unmount())
    expect(stub.disposeSpy).toHaveBeenCalledTimes(1)
  })
})
