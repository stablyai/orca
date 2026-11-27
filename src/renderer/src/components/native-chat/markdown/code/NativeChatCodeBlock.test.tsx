// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatCodeBlock, NativeChatDeferredCodeBlock } from './NativeChatCodeBlock'

// The grammar's wasm can't load here; a marker stands in for the colored tokens.
vi.mock('./NativeChatHighlightedCode', () => ({
  NativeChatHighlightedCode: ({ code }: { code: string }) => <span data-token="">{code}</span>
}))

// Visibility is driven by hand: nothing is on screen until a test says so.
let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null
const observed = new Set<Element>()
beforeEach(() => {
  observed.clear()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof report) {
        report = callback
      }
      observe(element: Element): void {
        observed.add(element)
      }
      unobserve(element: Element): void {
        observed.delete(element)
      }
      disconnect(): void {
        observed.clear()
      }
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const code = (n: number) =>
  Array.from({ length: n }, (_, i) => `const value${i}: number = ${i} // line`).join('\n')
const tokens = (container: HTMLElement) =>
  container.querySelectorAll('[data-native-chat-code-content] [data-token]').length
const show = (container: HTMLElement, visible: boolean) =>
  act(() => {
    const pre = container.querySelector('[data-native-chat-code-content]')!
    report?.([{ target: pre, isIntersecting: visible }])
  })

it('colors chat blocks at once, never waiting to be seen', () => {
  const { container } = render(<NativeChatCodeBlock language="ts">{code(3)}</NativeChatCodeBlock>)
  // Colored on the first render: no plain frame before an observer reports.
  expect(tokens(container)).toBe(1)
  // Nothing watches chat blocks, so revealing one never swaps its text nodes under find.
  expect(observed.size).toBe(0)
})

it('keeps item blocks off screen plain until seen', () => {
  const { container } = render(
    <NativeChatDeferredCodeBlock language="ts">{code(4)}</NativeChatDeferredCodeBlock>
  )
  expect(tokens(container)).toBe(0)
  expect(observed.size).toBe(1)
  show(container, true)
  expect(tokens(container)).toBe(1)
})

it('keeps an item block colored once seen, as it scrolls away or its text grows', () => {
  const { container, rerender } = render(
    <NativeChatDeferredCodeBlock language="ts">{code(5)}</NativeChatDeferredCodeBlock>
  )
  show(container, true)
  show(container, false)
  rerender(<NativeChatDeferredCodeBlock language="ts">{code(6)}</NativeChatDeferredCodeBlock>)
  expect(tokens(container)).toBe(1)
  expect(observed.size).toBe(0)
})
