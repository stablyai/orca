import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelayedStatus, STATUS_MIN_VISIBLE_MS, type ShownStatus } from './delayed-status'

const SHOW_DELAY_MS = 1_000

function track() {
  const changes: (ShownStatus<string> | null)[] = []
  const status = createDelayedStatus<string>((shown) => changes.push(shown), {
    showDelayMs: SHOW_DELAY_MS
  })
  return { status, changes }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createDelayedStatus', () => {
  it('never shows a status that clears within the show delay', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1)
    status.update('a', null)
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2)
    expect(changes).toEqual([])
  })

  it('shows a status that outlasts the show delay', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(changes).toEqual([{ key: 'a', value: 'starting' }])
  })

  it('keeps a shown status up for the minimum visible time', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    status.update('a', null)
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS - 1)
    expect(changes).toEqual([{ key: 'a', value: 'starting' }])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([{ key: 'a', value: 'starting' }, null])
  })

  it('hides at once when the status clears after the minimum visible time', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    vi.advanceTimersByTime(SHOW_DELAY_MS + STATUS_MIN_VISIBLE_MS)
    status.update('a', null)
    expect(changes).toEqual([{ key: 'a', value: 'starting' }, null])
  })

  it('restarts the show delay when an unkeyed status clears and returns during its hold', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    status.update('a', null)
    vi.advanceTimersByTime(100)
    status.update('a', 'starting')
    expect(changes).toEqual([{ key: 'a', value: 'starting' }, null])
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1)
    expect(changes).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(changes.at(-1)).toEqual({ key: 'a', value: 'starting' })
  })

  it('drops the shown status at once for a new key, which waits its own delay', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    status.update('b', 'starting')
    expect(changes).toEqual([{ key: 'a', value: 'starting' }, null])
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(changes.at(-1)).toEqual({ key: 'b', value: 'starting' })
  })

  it('does not show after dispose', () => {
    const { status, changes } = track()
    status.update('a', 'starting')
    status.dispose()
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2)
    expect(changes).toEqual([])
  })
})
