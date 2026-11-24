// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SendNotesButton, SendNotesSlot } from './SendNotesButton'

type Observer = {
  callback: ResizeObserverCallback
  disconnected: boolean
  targets: Set<Element>
  self: ResizeObserver
}
// tierWidths: the full, short and icon labels as the sizer lays them out.
const layout = vi.hoisted(
  (): { slotWidth: number; tierWidths: number[]; observers: Observer[] } => ({
    slotWidth: 0,
    tierWidths: [],
    observers: []
  })
)

function rect(width: number): DOMRect {
  return new DOMRect(0, 0, width, 28)
}

beforeEach(() => {
  layout.observers = []
  layout.tierWidths = [112, 72, 44]
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private entry: Observer
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, disconnected: false, targets: new Set(), self: this }
        layout.observers.push(this.entry)
      }
      observe(target: Element): void {
        this.entry.targets.add(target)
      }
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
      return rect(layout.tierWidths[Array.from(tiers.children).indexOf(this)] ?? 0)
    }
    return rect(0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Like a real ResizeObserver: only observers watching the resized element hear about it.
function resized(target: Element): void {
  act(() => {
    for (const observer of layout.observers) {
      if (!observer.disconnected && observer.targets.has(target)) {
        observer.callback([], observer.self)
      }
    }
  })
}

function resizeSlot(width: number): void {
  layout.slotWidth = width
  resized(document.querySelector('[data-send-notes-slot]')!)
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

  it('re-picks the label when only a narrower label changes width', () => {
    layout.slotWidth = 80
    renderInSlot(3)
    const button = screen.getByRole('button', { name: 'Send 3 notes to an agent' })
    expect(button).toHaveTextContent(/^Send 3$/)

    // A font or language change widens "Send 3" alone; the widest label keeps its width.
    layout.tierWidths = [112, 90, 44]
    resized(document.querySelector('[inert] > span')!.children[1])

    expect(button).toHaveTextContent(/^3$/)
  })

  it('measures each label with the same classes the live button paints', () => {
    layout.slotWidth = 200
    renderInSlot(3)
    const button = screen.getByRole('button', { name: 'Send 3 notes to an agent' })
    const sizers = Array.from(document.querySelector('[inert] > span')!.children)
    expect(sizers).toHaveLength(3)
    for (const sizer of sizers) {
      expect(sizer.className).toBe(button.className)
    }
  })

  it('stops observing the row when the button goes away', () => {
    layout.slotWidth = 200
    const view = renderInSlot(3)
    expect(layout.observers.some((observer) => !observer.disconnected)).toBe(true)

    view.unmount()

    expect(layout.observers.every((observer) => observer.disconnected)).toBe(true)
  })
})
