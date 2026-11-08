// @vitest-environment happy-dom

import { cleanup } from '@testing-library/react'
import { render } from '../../messages/actions/native-chat-tooltip-test-harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { list, marker, stubLayout, windowState } from './native-chat-windowing-test-harness'

let restoreLayout = (): void => {}
beforeEach(() => {
  restoreLayout = stubLayout()
})
afterEach(() => {
  cleanup()
  restoreLayout()
})

function mountedRows(container: HTMLElement): Map<number, HTMLElement> {
  return new Map(
    Array.from(container.querySelectorAll<HTMLElement>('[data-index]'), (row) => [
      Number(row.dataset.index),
      row
    ])
  )
}

// ceil(600px viewport / 44px row pitch) = 14 visible, 2 x 6 overscan, and the pinned latest row.
const MOUNTED_ROW_BOUND = 27

describe('windowed transcript row budget', () => {
  it.each([200, 2_000])('mounts a bounded row set from a %i-message transcript', (count) => {
    const transcript = Array.from({ length: count }, (_, index) => marker(index))
    const { container, rerender } = render(list(transcript))
    const opened = windowState(container)
    expect(opened.indexes.length).toBeLessThanOrEqual(MOUNTED_ROW_BOUND)
    expect(opened.indexes).toContain(count - 1)
    const before = mountedRows(container)

    rerender(list([...transcript, marker(count)]))
    const appended = windowState(container)
    expect(appended.indexes.length).toBeLessThanOrEqual(MOUNTED_ROW_BOUND)
    expect(appended.indexes).toContain(count)
    expect(container.textContent).toContain(`marker-${count}`)
    const after = mountedRows(container)
    const kept = [...before].filter(([index]) => after.has(index))
    expect(kept.length).toBeGreaterThan(0)
    for (const [index, row] of kept) {
      expect(after.get(index)).toBe(row)
    }
  })
})
