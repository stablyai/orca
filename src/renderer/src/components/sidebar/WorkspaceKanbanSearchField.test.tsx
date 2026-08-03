// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceKanbanSearchField, { overlayReserve } from './WorkspaceKanbanSearchField'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const onQueryChange = vi.fn()
const onClear = vi.fn()
const onClose = vi.fn()

function renderField(props: {
  query: string
  isFiltering?: boolean
  isTooLarge?: boolean
  matchCount?: number
  totalCount?: number
}): void {
  act(() => {
    root.render(
      <WorkspaceKanbanSearchField
        query={props.query}
        isFiltering={props.isFiltering ?? props.query.trim() !== ''}
        isTooLarge={props.isTooLarge ?? false}
        matchCount={props.matchCount ?? 0}
        totalCount={props.totalCount ?? 0}
        onQueryChange={onQueryChange}
        onClear={onClear}
        onClose={onClose}
      />
    )
  })
}

function input(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('input')
  if (!element) {
    throw new Error('field not rendered')
  }
  return element
}

function clearButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')
}

function liveRegion(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[aria-live="polite"]')
  if (!element) {
    throw new Error('live region not rendered')
  }
  return element
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('WorkspaceKanbanSearchField', () => {
  it('reports every keystroke without debouncing', () => {
    renderField({ query: '' })

    act(() => {
      // Why: React's value tracker shadows the `value` property, so a plain
      // assignment would look like a no-op and never fire onChange.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), 'or')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onQueryChange).toHaveBeenCalledWith('or')
  })

  it('only offers the clear affordance for a non-empty query', () => {
    renderField({ query: '' })
    expect(clearButton()).toBeNull()

    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    act(() => {
      clearButton()?.click()
    })

    expect(onClear).toHaveBeenCalledOnce()
  })

  it('hides the visual match count from assistive tech but keeps the clear button named', () => {
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })

    const count = container.querySelector('span[aria-hidden="true"]')
    expect(count?.textContent).toBe('3 / 12')
    expect(clearButton()?.getAttribute('aria-hidden')).toBeNull()
    expect(clearButton()?.getAttribute('aria-label')).toBe('Clear search')
  })

  it('withholds counts for text that never narrows the board', () => {
    renderField({ query: '   ', isFiltering: false, matchCount: 12, totalCount: 12 })

    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull()
    expect(clearButton()).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(liveRegion().textContent).toBe('')
  })

  it('announces match counts only after the query settles', () => {
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    expect(liveRegion().textContent).toBe('')

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(liveRegion().textContent).toBe('3 of 12 workspaces match')

    renderField({ query: 'zzz', matchCount: 0, totalCount: 12 })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(liveRegion().textContent).toBe('No workspaces match')

    renderField({ query: '' })
    expect(liveRegion().textContent).toBe('')
  })

  it('clears a non-empty query on Escape and closes the board on an empty one', () => {
    // Why: useWorkspaceBoardPanel's Escape listener is capture-phase on
    // document, so it runs before this handler and stopPropagation cannot
    // reach it. The panel defers to board text fields instead, which makes
    // this field solely responsible for both Escape outcomes.
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(onClear).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()

    renderField({ query: '' })
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(onClear).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('says so when a query was discarded for length instead of silently not filtering', () => {
    // Why: an over-bound query and a query that matched everything look
    // identical — full field, untouched board — without this.
    renderField({ query: 'x'.repeat(3000), isFiltering: false, isTooLarge: true })

    expect(container.textContent).toContain('Too long')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(liveRegion().textContent).toContain('too long')

    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    expect(container.textContent).not.toContain('Too long')
    expect(input().getAttribute('aria-invalid')).toBeNull()
  })

  it('leaves Escape to the IME while a composition is in progress', () => {
    renderField({ query: '検索', matchCount: 1, totalCount: 12 })

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(onClear).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still clears on an unmarked Escape after a composition that never ended', () => {
    // Why: compositionend is not guaranteed, and this field is the board's only
    // Escape handler, so trusting the document flag alone would strand the query.
    renderField({ query: '検索', matchCount: 1, totalCount: 12 })

    act(() => {
      input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('keeps focus in the field after the clear button unmounts itself', () => {
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    act(() => {
      input().focus()
      clearButton()?.click()
    })

    expect(onClear).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input())
  })

  it('reserves overlay width in font-relative units, capped so text stays visible', () => {
    // '298 / 1024' is 10 characters; a fixed reserve would let it overlap.
    expect(overlayReserve('298 / 1024')).toContain('10ch')
    expect(overlayReserve('3 / 9')).toContain('5ch')

    // Capped, so a wide counter in a narrow drawer cannot squeeze the typed
    // text to nothing — overlapping is the better failure at that size.
    expect(overlayReserve('298 / 1024')).toContain('55%')

    // No overlay means only the clear button needs clearing.
    expect(overlayReserve(null)).toBe('32px')
  })
})
