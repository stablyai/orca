import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOptionAsAltProbe } from './option-as-alt-probe'
import { effectiveMacOptionAsAlt, type LayoutMapLike } from './detect-option-as-alt'
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

const TURKISH_MAP: LayoutMapLike = {
  size: 9,
  get: (code) =>
    ({
      KeyQ: 'q',
      KeyW: 'w',
      KeyA: 'a',
      KeyZ: 'z',
      Semicolon: 'ş',
      Quote: 'i',
      Backquote: '"',
      BracketLeft: 'ğ',
      BracketRight: 'ü'
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

describe('createOptionAsAltProbe', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['com.apple.keylayout.ABCExtended', 'com.apple.inputmethod.SCIM.ITABC'])(
    'uses the native input source %s before its backing layout or preference',
    async (inputSourceId) => {
      const getKeyboardLayoutSnapshot = vi.fn(async () => ({
        inputSourceId,
        layoutSourceId: 'com.apple.keylayout.ABC',
        keyCharacters: {}
      }))
      const getKeyboardInputSourceId = vi.fn(async () => 'com.apple.keylayout.US')
      vi.stubGlobal('window', {
        api: { app: { getKeyboardLayoutSnapshot, getKeyboardInputSourceId } }
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
      const probe = createOptionAsAltProbe(makeMockWindow(US_MAP, 'Macintosh') as unknown as Window)

      await probe.refresh()

      expect(probe.getCurrent()).toBe('non-us')
      expect(getKeyboardLayoutSnapshot).toHaveBeenCalled()
      expect(getKeyboardInputSourceId).not.toHaveBeenCalled()
      probe.dispose()
    }
  )

  it('starts as unknown, upgrades after first probe resolves', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    expect(probe.getCurrent()).toBe('unknown')
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')
    probe.dispose()
  })

  it('detects non-US layout (Turkish)', async () => {
    const win = makeMockWindow(TURKISH_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })

  it('notifies subscribers when category changes', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    const listener = vi.fn()
    probe.subscribe(listener)
    await probe.refresh()
    expect(listener).toHaveBeenCalledWith('us')
    probe.dispose()
  })

  it('does not notify when category is unchanged', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    const listener = vi.fn()
    probe.subscribe(listener)
    await probe.refresh()
    expect(listener).not.toHaveBeenCalled()
    probe.dispose()
  })

  it('re-probes on window focus-in and tracks layout switch', async () => {
    // Simulate the real case: US at boot, user switches to Turkish mid-session.
    let active: LayoutMapLike = US_MAP
    const win = makeMockWindow(US_MAP)
    win.navigator.keyboard = { getLayoutMap: async () => active }

    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')

    active = TURKISH_MAP
    win.fireFocus()
    // Let the focus-triggered probe resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })

  it('updates Auto on ABC/international switches while preserving every explicit mode', async () => {
    let activeInputSourceId = 'com.apple.keylayout.ABC'
    let notifyLayoutChanged: (() => void) | undefined
    const unsubscribe = vi.fn()
    const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window, {
      readInputSourceId: async () => activeInputSourceId,
      subscribeKeyboardLayoutChanged: (callback) => {
        notifyLayoutChanged = callback
        return unsubscribe
      }
    })
    const expectEffectiveModes = (automatic: 'true' | 'false') => {
      expect(effectiveMacOptionAsAlt('auto', probe.getCurrent())).toBe(automatic)
      for (const mode of ['true', 'false', 'left', 'right'] as const) {
        expect(effectiveMacOptionAsAlt(mode, probe.getCurrent())).toBe(mode)
      }
    }
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')
    expectEffectiveModes('true')

    for (const [id, category, automatic] of [
      ['USInternational-PC', 'non-us', 'false'],
      ['ABC', 'us', 'true']
    ] as const) {
      activeInputSourceId = `com.apple.keylayout.${id}`
      notifyLayoutChanged?.()
      expect(probe.getCurrent()).toBe('unknown')
      expectEffectiveModes('false')
      await Promise.resolve()
      await Promise.resolve()
      expect(probe.getCurrent()).toBe(category)
      expectEffectiveModes(automatic)
    }

    probe.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
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
    const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window, {
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
    const probe = createOptionAsAltProbe(win as unknown as Window, {
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

  it('stays unknown if navigator.keyboard is unavailable', async () => {
    const win = makeMockWindow(null)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    expect(probe.getCurrent()).toBe('unknown')
    probe.dispose()
  })

  it('survives a rejected getLayoutMap without clobbering last-known value', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')

    win.navigator.keyboard = {
      getLayoutMap: vi.fn(async () => {
        throw new Error('transient')
      })
    }
    await probe.refresh()
    // Still 'us'; we refuse to flip back to 'unknown' on transient failure.
    expect(probe.getCurrent()).toBe('us')
    probe.dispose()
  })

  it('dispose removes focus listener', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    const listener = vi.fn()
    probe.subscribe(listener)
    probe.dispose()
    win.fireFocus()
    // No further calls after dispose.
    expect(listener).not.toHaveBeenCalled()
  })

  it('forces non-us when the input source ID is not on the Option-as-Meta allowlist (#1205)', async () => {
    // The native ID protects composition even when the base layer matches US.
    for (const id of [
      'com.apple.keylayout.USInternational-PC',
      'com.apple.keylayout.USExtended',
      'com.apple.keylayout.ABCExtended',
      'com.apple.keylayout.PolishPro'
    ]) {
      const win = makeMockWindow(US_MAP)
      const probe = createOptionAsAltProbe(win as unknown as Window, {
        readInputSourceId: async () => id
      })
      await probe.refresh()
      expect(probe.getCurrent()).toBe('non-us')
      probe.dispose()
    }
  })

  it.each(['US', 'ABC'])(
    'resolves to us for standard %s without a browser layout map',
    async (id) => {
      const win = makeMockWindow(null, 'Macintosh')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
      const probe = createOptionAsAltProbe(win as unknown as Window, {
        readInputSourceId: async () => `com.apple.keylayout.${id}`
      })
      await probe.refresh()
      expect(probe.getCurrent()).toBe('us')
      probe.dispose()
    }
  )

  it.each(['Linux', 'Windows'])(
    'uses the fingerprint without native identity on %s',
    async (userAgent) => {
      const win = makeMockWindow(US_MAP, userAgent)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
      const probe = createOptionAsAltProbe(win as unknown as Window, {
        readInputSourceId: async () => null
      })
      await probe.refresh()
      expect(probe.getCurrent()).toBe('us')
      probe.dispose()
    }
  )

  it.each(['unavailable', 'rejected'] as const)(
    'stays conservative on macOS when current-source identity is %s',
    async (result) => {
      const win = makeMockWindow(US_MAP, 'Macintosh')
      const readInputSourceId = vi.fn(async () => {
        if (result === 'rejected') {
          throw new Error('identity unavailable')
        }
        return null
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
      const probe = createOptionAsAltProbe(win as unknown as Window, { readInputSourceId })
      await probe.refresh()
      expect(probe.getCurrent()).toBe('unknown')
      expect(effectiveMacOptionAsAlt('auto', probe.getCurrent())).toBe('false')
      for (const mode of ['true', 'false', 'left', 'right'] as const) {
        expect(effectiveMacOptionAsAlt(mode, probe.getCurrent())).toBe(mode)
      }
      expect(win.navigator.keyboard?.getLayoutMap).not.toHaveBeenCalled()
      probe.dispose()
    }
  )

  it('stays conservative on macOS without either native identity API', async () => {
    vi.stubGlobal('window', { api: { app: {} } })
    const win = makeMockWindow(US_MAP, 'Macintosh')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
    const probe = createOptionAsAltProbe(win as unknown as Window)
    await probe.refresh()
    expect(probe.getCurrent()).toBe('unknown')
    expect(win.navigator.keyboard?.getLayoutMap).not.toHaveBeenCalled()
    probe.dispose()
  })

  it('recovers macOS source identity after losing it without trusting the backing map', async () => {
    let activeInputSourceId: string | null = 'com.apple.keylayout.ABC'
    const win = makeMockWindow(US_MAP, 'Macintosh')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => activeInputSourceId
    })
    const listener = vi.fn()
    probe.subscribe(listener)
    for (const [id, category] of [
      ['com.apple.keylayout.ABC', 'us'],
      [null, 'unknown'],
      ['com.apple.inputmethod.SCIM.ITABC', 'non-us'],
      ['com.apple.keylayout.ABC', 'us']
    ] as const) {
      activeInputSourceId = id
      await probe.refresh()
      expect(probe.getCurrent()).toBe(category)
    }
    expect(listener.mock.calls.map(([category]) => category)).toEqual([
      'us',
      'unknown',
      'non-us',
      'us'
    ])
    expect(win.navigator.keyboard?.getLayoutMap).not.toHaveBeenCalled()
    probe.dispose()
  })

  it('falls back to the fingerprint off macOS when the input-source reader throws', async () => {
    const win = makeMockWindow(TURKISH_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => {
        throw new Error('ipc unavailable')
      }
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })

  it('re-probes the input source ID on focus-in so mid-session layout switches are picked up', async () => {
    // The browser fingerprint stays US while the native identity changes.
    let activeInputSourceId: string | null = 'com.apple.keylayout.ABC'
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => activeInputSourceId
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')

    activeInputSourceId = 'com.apple.keylayout.USInternational-PC'
    win.fireFocus()
    // Let the focus-triggered probe resolve.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('non-us')
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
    const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window, {
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every Window member the probe reads.
      const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window, {
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
