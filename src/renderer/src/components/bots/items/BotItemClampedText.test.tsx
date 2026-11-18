// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotItemClampedText } from './BotItemClampedText'

const resized: (() => void)[] = []

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized.push(callback)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resized.length = 0
})

it('offers Show more once a narrower pane makes the text overflow its cut', () => {
  const { container } = render(
    <BotItemClampedText text="A comment that fits at first." clampClassName="max-h-[228px]" />
  )
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()

  // The pane narrows: the text now runs past the 228 px cut.
  const cut = container.firstElementChild!.firstElementChild!
  Object.defineProperty(cut, 'scrollHeight', { configurable: true, value: 400 })
  Object.defineProperty(cut, 'clientHeight', { configurable: true, value: 228 })
  act(() => resized.forEach((callback) => callback()))

  expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy()
})
