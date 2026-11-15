// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatDeferredMarkdownImage } from './NativeChatDeferredMarkdownImage'

vi.mock('./NativeChatMarkdownImage', () => ({
  NativeChatMarkdownImage: () => <button>Preview</button>
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('releases the placeholder observation when the preview mounts and keeps the preview', () => {
  const observed = new Map<Element, (entries: IntersectionObserverEntry[]) => void>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly report: (entries: IntersectionObserverEntry[]) => void) {}
      observe(element: Element): void {
        observed.set(element, this.report)
      }
      unobserve(element: Element): void {
        observed.delete(element)
      }
      disconnect(): void {
        observed.clear()
      }
    }
  )
  render(<NativeChatDeferredMarkdownImage src="shots/chart.png" alt="Chart" />)
  const placeholder = screen.getByRole('img', { name: 'Chart' })
  const report = observed.get(placeholder)!
  const intersect = (isIntersecting: boolean): void => {
    act(() => {
      const bounds = placeholder.getBoundingClientRect()
      report([
        {
          target: placeholder,
          isIntersecting,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0
        }
      ])
    })
  }
  expect(screen.queryByRole('button')).toBeNull()
  intersect(true)
  expect(observed.has(placeholder)).toBe(false)
  expect(screen.getByRole('button')).toBeInTheDocument()
  intersect(false)
  expect(screen.getByRole('button')).toBeInTheDocument()
})
