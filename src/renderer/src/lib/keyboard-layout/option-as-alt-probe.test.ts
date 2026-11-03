import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOptionAsAltProbe } from './option-as-alt-probe'
import type { LayoutMapLike } from './detect-option-as-alt'
import type { KeyboardLayoutChangeEvent } from '../../../../shared/keyboard-layout-events'

const US_MAP: LayoutMapLike = {
  size: 9,
  get: (code) =>
    ({
      KeyQ: 'q',
      KeyW: 'w',
      KeyA: 'a',
      KeyZ: 'z',
      Semicolon: ';',
      Quote: "'",
      Backquote: '`',
      BracketLeft: '[',
      BracketRight: ']'
    })[code]
}

type MockWindow = {
  navigator: {
    userAgent: string
    keyboard?: { getLayoutMap: () => Promise<LayoutMapLike> }
  }
  addEventListener: (type: string, fn: EventListener) => void
  removeEventListener: (type: string, fn: EventListener) => void
  fireFocus: () => void
}

function makeMockWindow(initial: LayoutMapLike | null, userAgent = 'Linux'): MockWindow {
  const focusListeners = new Set<EventListener>()
  let current = initial
  return {
    navigator: {
      userAgent,
      keyboard: current
        ? {
            getLayoutMap: vi.fn(async () => current!)
          }
        : undefined
    },
    addEventListener: (type, fn) => {
      if (type === 'focus') {
        focusListeners.add(fn)
      }
    },
    removeEventListener: (type, fn) => {
      if (type === 'focus') {
        focusListeners.delete(fn)
      }
    },
    fireFocus: () => {
      for (const fn of focusListeners) {
        fn(new Event('focus'))
      }
    }
  }
}

function asWindow(mock: MockWindow): Window {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe reads only navigator and the focus listeners, which MockWindow supplies.
  return mock as unknown as Window
}

describe('createOptionAsAltProbe', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fences an in-flight probe until the matching refresh phase', async () => {
    let notifyLayoutChanged: ((event: KeyboardLayoutChangeEvent) => void) | undefined
    let finishOldRead!: (inputSourceId: string) => void
    const oldRead = new Promise<string>((resolve) => {
      finishOldRead = resolve
    })
    const readInputSourceId = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldRead)
      .mockResolvedValue('com.apple.keylayout.PolishPro')
    const probe = createOptionAsAltProbe(asWindow(makeMockWindow(US_MAP)), {
      readInputSourceId,
      subscribeKeyboardLayoutChanged: (callback) => {
        notifyLayoutChanged = callback
        return vi.fn()
      }
    })

    notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
    finishOldRead('com.apple.keylayout.ABC')
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('unknown')

    notifyLayoutChanged?.({ phase: 'refresh', generation: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })

  it('blocks focus and manual probes until the matching refresh phase', async () => {
    let notifyLayoutChanged: ((event: KeyboardLayoutChangeEvent) => void) | undefined
    const readInputSourceId = vi.fn(async () => 'com.apple.keylayout.US')
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(asWindow(win), {
      readInputSourceId,
      subscribeKeyboardLayoutChanged: (callback) => {
        notifyLayoutChanged = callback
        return vi.fn()
      }
    })
    await probe.refresh()
    const readsBeforeInvalidation = readInputSourceId.mock.calls.length

    notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
    win.fireFocus()
    await probe.refresh()

    expect(probe.getCurrent()).toBe('unknown')
    expect(readInputSourceId).toHaveBeenCalledTimes(readsBeforeInvalidation)

    notifyLayoutChanged?.({ phase: 'refresh', generation: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('us')
    expect(readInputSourceId).toHaveBeenCalledTimes(readsBeforeInvalidation + 1)
    probe.dispose()
  })

  it('does not let an older probe overwrite a newer input source', async () => {
    let resolveOld!: (value: string | null) => void
    let resolveNew!: (value: string | null) => void
    const oldRead = new Promise<string | null>((resolve) => {
      resolveOld = resolve
    })
    const newRead = new Promise<string | null>((resolve) => {
      resolveNew = resolve
    })
    const readInputSourceId = vi
      .fn<() => Promise<string | null>>()
      .mockReturnValueOnce(oldRead)
      .mockReturnValueOnce(newRead)
    const probe = createOptionAsAltProbe(asWindow(makeMockWindow(US_MAP)), {
      readInputSourceId
    })
    const newestProbe = probe.refresh()

    resolveNew('com.apple.keylayout.PolishPro')
    await newestProbe
    expect(probe.getCurrent()).toBe('non-us')
    resolveOld('com.apple.keylayout.ABC')
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })

  it.each(['before', 'after'] as const)(
    'fences superseded layout generations when the stale read resolves %s the newest',
    async (order) => {
      let activeRead: Promise<string | null> = Promise.resolve('com.apple.keylayout.ABC')
      let notifyLayoutChanged: ((event: KeyboardLayoutChangeEvent) => void) | undefined
      const readInputSourceId = vi.fn(() => activeRead)
      const probe = createOptionAsAltProbe(asWindow(makeMockWindow(US_MAP)), {
        readInputSourceId,
        subscribeKeyboardLayoutChanged: (callback) => {
          notifyLayoutChanged = callback
          return vi.fn()
        }
      })
      await probe.refresh()
      expect(probe.getCurrent()).toBe('us')
      const listener = vi.fn()
      probe.subscribe(listener)

      const staleRead = Promise.withResolvers<string | null>()
      const newestRead = Promise.withResolvers<string | null>()
      activeRead = staleRead.promise
      notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
      notifyLayoutChanged?.({ phase: 'refresh', generation: 1 })
      notifyLayoutChanged?.({ phase: 'invalidated', generation: 2 })
      const readsBeforeStaleNotifications = readInputSourceId.mock.calls.length
      notifyLayoutChanged?.({ phase: 'refresh', generation: 1 })
      notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
      expect(readInputSourceId).toHaveBeenCalledTimes(readsBeforeStaleNotifications)

      activeRead = newestRead.promise
      notifyLayoutChanged?.({ phase: 'refresh', generation: 2 })
      if (order === 'before') {
        staleRead.resolve('com.apple.keylayout.PolishPro')
        await Promise.resolve()
        expect(probe.getCurrent()).toBe('unknown')
      }
      newestRead.resolve('com.apple.keylayout.ABC')
      await Promise.resolve()
      expect(probe.getCurrent()).toBe('us')
      if (order === 'after') {
        staleRead.resolve('com.apple.keylayout.PolishPro')
        await Promise.resolve()
      }
      notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
      expect(probe.getCurrent()).toBe('us')
      expect(listener.mock.calls.map(([category]) => category)).toEqual(['unknown', 'us'])
      probe.dispose()
    }
  )
})
