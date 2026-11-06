import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackTerminalPaneSplit } from './feature-education-telemetry'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('./telemetry', () => ({
  track: trackMock
}))

afterEach(() => {
  trackMock.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('feature education telemetry helpers', () => {
  it('caps terminal pane split telemetry by source and direction for each UTC day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T12:00:00.000Z'))
    vi.stubGlobal('localStorage', createMemoryStorage())

    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'vertical' })
    trackTerminalPaneSplit({ source: 'context_menu', direction: 'horizontal' })

    expect(trackMock).toHaveBeenCalledTimes(3)
    expect(trackMock).toHaveBeenNthCalledWith(1, 'terminal_pane_split', {
      source: 'keyboard',
      direction: 'horizontal'
    })
    expect(trackMock).toHaveBeenNthCalledWith(2, 'terminal_pane_split', {
      source: 'keyboard',
      direction: 'vertical'
    })
    expect(trackMock).toHaveBeenNthCalledWith(3, 'terminal_pane_split', {
      source: 'context_menu',
      direction: 'horizontal'
    })

    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'))
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })

    expect(trackMock).toHaveBeenCalledTimes(4)
  })
})

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}
