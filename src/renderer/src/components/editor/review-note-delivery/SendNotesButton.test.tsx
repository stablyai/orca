// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SendNotesButton, SendNotesSlot } from './SendNotesButton'

// Widths of the full, short and icon labels as the sizer lays them out.
const TIER_WIDTHS = [112, 72, 44]

type Observer = { callback: ResizeObserverCallback; disconnected: boolean; self: ResizeObserver }
const layout = vi.hoisted((): { slotWidth: number; observers: Observer[] } => ({
  slotWidth: 0,
  observers: []
}))

function rect(width: number): DOMRect {
  return new DOMRect(0, 0, width, 28)
}

beforeEach(() => {
  layout.observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private entry: Observer
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, disconnected: false, self: this }
        layout.observers.push(this.entry)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        this.entry.disconnected = true
      }
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-send-notes-slot')) {
      return rect(layout.slotWidth)
    }
    const tiers = this.parentElement
    if (tiers?.parentElement?.hasAttribute('inert')) {
      return rect(TIER_WIDTHS[Array.from(tiers.children).indexOf(this)] ?? 0)
    }
    return rect(0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function resizeSlot(width: number): void {
  layout.slotWidth = width
  act(() => {
    for (const observer of layout.observers) {
      observer.callback([], observer.self)
    }
  })
}

function renderInSlot(count: number): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <SendNotesSlot>
        <SendNotesButton count={count} />
      </SendNotesSlot>
    </TooltipProvider>
  )
}

describe('SendNotesButton', () => {
  it('names one note in the singular and several in the plural', () => {
    render(
      <TooltipProvider>
        <SendNotesButton count={1} />
        <SendNotesButton count={3} />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: 'Send 1 note to an agent' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send 3 notes to an agent' })).toBeVisible()
  })

  it('shortens its label to the space after the title', () => {
    layout.slotWidth = 200
    renderInSlot(3)
    const button = screen.getByRole('button', { name: 'Send 3 notes to an agent' })
    expect(button).toHaveTextContent('Send 3 notes')

    resizeSlot(80)
    expect(button).toHaveTextContent(/^Send 3$/)

    resizeSlot(50)
    expect(button).toHaveTextContent(/^3$/)
    // The icon tier drops the menu chevron; only the send icon is left.
    expect(button.querySelectorAll('svg')).toHaveLength(1)

    resizeSlot(200)
    expect(button).toHaveTextContent('Send 3 notes')
  })

  it('stops observing the row when the button goes away', () => {
    layout.slotWidth = 200
    const view = renderInSlot(3)
    expect(layout.observers.some((observer) => !observer.disconnected)).toBe(true)

    view.unmount()

    expect(layout.observers.every((observer) => observer.disconnected)).toBe(true)
  })
})
