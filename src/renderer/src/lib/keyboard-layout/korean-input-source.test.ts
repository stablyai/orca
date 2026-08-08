import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetKoreanInputSourceForTests,
  _setKoreanInputSourceForTests,
  isKoreanInputSourceActive,
  isKoreanInputSourceId,
  prefetchKoreanInputSource
} from './korean-input-source'

type MockWindow = {
  addEventListener: (type: string, fn: EventListener, capture?: boolean) => void
  removeEventListener: (type: string, fn: EventListener, capture?: boolean) => void
  fireFocus: () => void
  fireKey: (code: string) => void
}

function makeMockWindow(): MockWindow {
  const focusListeners = new Set<EventListener>()
  const keyListeners = new Set<EventListener>()
  return {
    addEventListener: (type, fn) => {
      if (type === 'focus') {
        focusListeners.add(fn)
      } else if (type === 'keydown' || type === 'keyup') {
        keyListeners.add(fn)
      }
    },
    removeEventListener: (type, fn) => {
      if (type === 'focus') {
        focusListeners.delete(fn)
      } else if (type === 'keydown' || type === 'keyup') {
        keyListeners.delete(fn)
      }
    },
    fireFocus: () => {
      for (const listener of focusListeners) {
        listener(new Event('focus'))
      }
    },
    fireKey: (code: string) => {
      // Why: the listener reads only event.code; a plain object avoids the
      // node test environment's missing KeyboardEvent global.
      const event = { code } as KeyboardEvent
      for (const listener of keyListeners) {
        listener(event)
      }
    }
  }
}

function deferred(): {
  promise: Promise<string | null>
  resolve: (id: string | null) => void
} {
  let resolve!: (id: string | null) => void
  const promise = new Promise<string | null>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('isKoreanInputSourceId', () => {
  it('recognizes every supported Korean input source ID', () => {
    const koreanIds = [
      // Input method modes, reported by the selected-source branch.
      'com.apple.inputmethod.Korean.2SetKorean',
      'com.apple.inputmethod.Korean.390Sebulshik',
      'com.apple.inputmethod.Korean.3SetKorean',
      'com.apple.inputmethod.Korean.HNCRomaja',
      'com.apple.inputmethod.Korean.GJCRomaja',
      // The IM bundle itself.
      'com.apple.inputmethod.Korean',
      // Keyboard layouts, reported by the fallback branch.
      'com.apple.keylayout.2SetHangul',
      'com.apple.keylayout.390Hangul',
      'com.apple.keylayout.3SetHangul',
      'com.apple.keylayout.HNCRomaja',
      'com.apple.keylayout.GJCRomaja'
    ]

    for (const id of koreanIds) {
      expect(isKoreanInputSourceId(id), id).toBe(true)
    }
  })

  it('rejects non-Korean input sources', () => {
    for (const id of [
      'com.apple.keylayout.US',
      'com.apple.keylayout.German',
      'com.apple.inputmethod.ABC',
      'com.apple.inputmethod.SCIM.ITABC'
    ]) {
      expect(isKoreanInputSourceId(id), id).toBe(false)
    }
  })

  it('rejects null and undefined', () => {
    expect(isKoreanInputSourceId(null)).toBe(false)
    expect(isKoreanInputSourceId(undefined)).toBe(false)
  })
})

describe('prefetchKoreanInputSource', () => {
  beforeEach(() => {
    _resetKoreanInputSourceForTests()
  })

  afterEach(() => {
    _resetKoreanInputSourceForTests()
    vi.restoreAllMocks()
  })

  it('classifies the active input source after the first probe', async () => {
    const reader = vi.fn(async () => 'com.apple.inputmethod.Korean.2SetKorean')
    prefetchKoreanInputSource({ win: makeMockWindow(), readInputSourceId: reader })

    await vi.waitFor(() => expect(isKoreanInputSourceActive()).toBe(true))
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('stays false when the probe reports a non-Korean input source', async () => {
    const reader = vi.fn(async () => 'com.apple.keylayout.US')
    prefetchKoreanInputSource({ win: makeMockWindow(), readInputSourceId: reader })

    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(false)
  })

  it('stays false when the probe reports no input source', async () => {
    const reader = vi.fn(async () => null)
    prefetchKoreanInputSource({ win: makeMockWindow(), readInputSourceId: reader })

    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(false)
  })

  it('keeps the last known classification when the reader rejects', async () => {
    _setKoreanInputSourceForTests(true)
    const reader = vi.fn(async () => {
      throw new Error('IPC down')
    })
    prefetchKoreanInputSource({ win: makeMockWindow(), readInputSourceId: reader })

    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(true)
  })

  it('commits only the latest refresh when probes overlap', async () => {
    const initialProbe = deferred()
    const focusProbe = deferred()
    const reader = vi.fn(() =>
      reader.mock.calls.length === 1 ? initialProbe.promise : focusProbe.promise
    )
    const win = makeMockWindow()
    prefetchKoreanInputSource({ win, readInputSourceId: reader })

    win.fireFocus()
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2))

    // The focus-in probe (current layout) resolves first and commits.
    focusProbe.resolve('com.apple.keylayout.US')
    await vi.waitFor(() => expect(isKoreanInputSourceActive()).toBe(false))

    // The stale initial probe resolves last; it must not overwrite the cache.
    initialProbe.resolve('com.apple.inputmethod.Korean.2SetKorean')
    await Promise.resolve()
    expect(isKoreanInputSourceActive()).toBe(false)
  })

  it('refreshes on window focus-in after a layout switch', async () => {
    let activeId: string | null = 'com.apple.keylayout.US'
    const reader = vi.fn(async () => activeId)
    const win = makeMockWindow()
    prefetchKoreanInputSource({ win, readInputSourceId: reader })

    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(false)

    activeId = 'com.apple.inputmethod.Korean.390Sebulshik'
    win.fireFocus()
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
    expect(isKoreanInputSourceActive()).toBe(true)
  })

  it('refreshes immediately on an input-toggle key even without focus changes', async () => {
    let activeId: string | null = 'com.apple.keylayout.US'
    const reader = vi.fn(async () => activeId)
    const win = makeMockWindow()
    prefetchKoreanInputSource({ win, readInputSourceId: reader })
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(false)

    // Caps Lock switches the input source in place — no blur/refocus.
    activeId = 'com.apple.inputmethod.Korean.2SetKorean'
    win.fireKey('CapsLock')
    await vi.waitFor(() => expect(isKoreanInputSourceActive()).toBe(true))
  })

  it('refreshes on ordinary keys but throttled by the cooldown', async () => {
    vi.useFakeTimers()
    try {
      let activeId: string | null = 'com.apple.keylayout.US'
      const reader = vi.fn(async () => activeId)
      const win = makeMockWindow()
      prefetchKoreanInputSource({ win, readInputSourceId: reader })
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
      expect(isKoreanInputSourceActive()).toBe(false)

      activeId = 'com.apple.inputmethod.Korean.2SetKorean'
      // Within the cooldown: ordinary keys are throttled.
      win.fireKey('KeyA')
      win.fireKey('KeyB')
      await Promise.resolve()
      expect(reader).toHaveBeenCalledTimes(1)

      // Past the cooldown: an ordinary key refreshes the gate.
      vi.advanceTimersByTime(3000)
      win.fireKey('KeyC')
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
      expect(isKoreanInputSourceActive()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is idempotent across calls', async () => {
    const reader = vi.fn(async () => 'com.apple.keylayout.2SetHangul')
    const win = makeMockWindow()
    prefetchKoreanInputSource({ win, readInputSourceId: reader })
    prefetchKoreanInputSource({ win, readInputSourceId: reader })

    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(true)
  })

  it('reset detaches listeners and invalidates in-flight probes', async () => {
    const probe = deferred()
    const reader = vi.fn(() => probe.promise)
    const win = makeMockWindow()
    prefetchKoreanInputSource({ win, readInputSourceId: reader })
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))

    _resetKoreanInputSourceForTests()
    win.fireFocus()
    win.fireKey('CapsLock')
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(isKoreanInputSourceActive()).toBe(false)

    // A probe still in flight from before the reset must not repopulate the cache.
    probe.resolve('com.apple.inputmethod.Korean.2SetKorean')
    await Promise.resolve()
    expect(isKoreanInputSourceActive()).toBe(false)

    // After reset, prefetch works again on the same window.
    prefetchKoreanInputSource({ win, readInputSourceId: reader })
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
  })
})

describe('cold-start probe', () => {
  beforeEach(() => {
    _resetKoreanInputSourceForTests()
  })

  it('does not cache a null read as a confirmed non-Korean source', async () => {
    // Why: on m4air a fresh session sent ₩ for the first presses — the startup
    // read returned null (IPC not exposed yet) and was cached as "not Korean".
    const win = makeMockWindow()
    let call = 0
    const reader = async (): Promise<string | null> => {
      call += 1
      return call === 1 ? null : 'com.apple.inputmethod.Korean.2SetKorean'
    }

    prefetchKoreanInputSource({ win, readInputSourceId: reader })
    await vi.waitFor(() => expect(isKoreanInputSourceActive()).toBe(true))
    expect(call).toBeGreaterThan(1)
  })

  it('gives up after a bounded number of probes when the reader never reports', async () => {
    const win = makeMockWindow()
    let call = 0
    const reader = async (): Promise<string | null> => {
      call += 1
      return null
    }

    prefetchKoreanInputSource({ win, readInputSourceId: reader })
    await vi.waitFor(() => expect(call).toBeGreaterThanOrEqual(4), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Each probe spawns four processes; an unbounded retry would be worse than
    // the cold gate it fixes.
    expect(call).toBeLessThanOrEqual(4)
    expect(isKoreanInputSourceActive()).toBe(false)
  })
})
