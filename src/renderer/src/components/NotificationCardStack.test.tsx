// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCardStack } from './NotificationCardStack'

/** A ResizeObserver that reports only what it observes, when the test resizes an element. */
class FakeResizeObserver implements ResizeObserver {
  static all: FakeResizeObserver[] = []
  private readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
  }

  static resize(target: Element): void {
    for (const observer of FakeResizeObserver.all) {
      if (observer.targets.has(target)) {
        observer.callback([], observer)
      }
    }
  }
}

function stackOf(card: HTMLElement): HTMLElement {
  const stack = card.parentElement
  if (!stack) {
    throw new Error('card is not in a stack')
  }
  return stack
}

/** Pins the stack's scroll metrics; its box stays capped at 220px while content grows. */
function capStack(stack: HTMLElement, content: { height: number }): void {
  Object.defineProperty(stack, 'clientHeight', { configurable: true, get: () => 220 })
  Object.defineProperty(stack, 'scrollHeight', { configurable: true, get: () => content.height })
}

describe('NotificationCardStack', () => {
  beforeEach(() => {
    FakeResizeObserver.all = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('starts scrolling when a card grows inside a stack already at its max height', () => {
    render(
      <NotificationCardStack>
        <div data-testid="card" />
      </NotificationCardStack>
    )
    const card = screen.getByTestId('card')
    const stack = stackOf(card)
    const content = { height: 220 }
    capStack(stack, content)
    act(() => FakeResizeObserver.resize(stack))
    expect(stack.hasAttribute('data-overflowing')).toBe(false)

    content.height = 240
    act(() => FakeResizeObserver.resize(card))

    expect(stack.hasAttribute('data-overflowing')).toBe(true)
  })

  it('watches a card that mounts after the stack', async () => {
    const { rerender } = render(
      <NotificationCardStack>
        <div data-testid="first" />
      </NotificationCardStack>
    )
    const stack = stackOf(screen.getByTestId('first'))
    const content = { height: 200 }
    capStack(stack, content)
    rerender(
      <NotificationCardStack>
        <div data-testid="first" />
        <div data-testid="second" />
      </NotificationCardStack>
    )
    // MutationObserver delivers on a microtask.
    await act(async () => {})

    content.height = 260
    act(() => FakeResizeObserver.resize(screen.getByTestId('second')))

    expect(stack.hasAttribute('data-overflowing')).toBe(true)
  })
})
