// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserTargetUrlChangedEvent } from '../../../../../shared/browser-guest-events'
import { BrowserLinkStatusBubble } from './browser-link-status-bubble'

let emit: (event: BrowserTargetUrlChangedEvent) => void

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onTargetUrlChanged: (callback: (event: BrowserTargetUrlChangedEvent) => void) => {
          emit = callback
          return () => {}
        }
      },
      ui: { getZoomLevel: () => 0 }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function hover(url: string, browserPageId = 'page-1'): void {
  act(() => emit({ browserPageId, url, screenX: 0, screenY: 0 }))
}

function advance(ms: number): void {
  act(() => vi.advanceTimersByTime(ms))
}

it('shows the hovered URL after a short delay, expands on a long hover and hides when the link is left', () => {
  const { container } = render(<BrowserLinkStatusBubble browserPageId="page-1" />)
  const bubble = container.querySelector<HTMLElement>('[data-browser-link-status]')!

  hover('https://example.com/docs', 'page-2')
  advance(500)
  expect(bubble.classList.contains('opacity-0')).toBe(true)

  hover('https://example.com/docs')
  advance(50)
  expect(bubble.classList.contains('opacity-0')).toBe(true)
  advance(50)
  expect(bubble.classList.contains('opacity-100')).toBe(true)
  expect(bubble.textContent).toBe('https://example.com/docs')

  const fullWidth = 'max-w-[calc(100%-0.5rem)]'
  expect(bubble.classList.contains(fullWidth)).toBe(false)
  advance(1600)
  expect(bubble.classList.contains(fullWidth)).toBe(true)

  hover('')
  advance(200)
  expect(bubble.classList.contains('opacity-100')).toBe(true)
  advance(100)
  expect(bubble.classList.contains('opacity-0')).toBe(true)
})

it('trims long URLs in the middle so the host and the end stay visible', () => {
  const { container } = render(<BrowserLinkStatusBubble browserPageId="page-1" />)
  const parts = (): string[] =>
    [...container.querySelectorAll('[data-browser-link-status] span')].map((s) => s.textContent!)

  hover('https://github.com/stablyai/orca/pulls?q=is%3Aopen#discussion-anchor')
  expect(parts()).toEqual([
    'https://github.com/stablyai/orca/pulls?q=is%3Aop',
    'en#discussion-anchor'
  ])

  hover('https://example.com/a')
  expect(parts()).toEqual(['https://example.com', '/a'])

  hover(`data:text/plain,${'x'.repeat(5000)}`)
  const [head, tail] = parts()
  expect(head.length).toBe(513)
  expect(head.endsWith('…')).toBe(true)
  expect(tail).toBe('x'.repeat(20))
})
