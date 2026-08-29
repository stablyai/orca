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
    keyboard?: { getLayoutMap: () => Promise<LayoutMapLike> }
  }
  addEventListener: (type: string, fn: EventListener) => void
  removeEventListener: (type: string, fn: EventListener) => void
  fireFocus: () => void
}

function makeMockWindow(initial: LayoutMapLike | null): MockWindow {
  const focusListeners = new Set<EventListener>()
  let current = initial
  return {
    navigator: {
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

  it('uses the native snapshot identity before the preference fallback', async () => {
    const getKeyboardLayoutSnapshot = vi.fn(async () => ({
      inputSourceId: 'com.apple.keylayout.ABC',
      keyCharacters: {}
    }))
    const getKeyboardInputSourceId = vi.fn(async () => 'com.apple.keylayout.US')
    vi.stubGlobal('window', {
      api: { app: { getKeyboardLayoutSnapshot, getKeyboardInputSourceId } }
    })
    const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window)

    await probe.refresh()

    expect(probe.getCurrent()).toBe('non-us')
    expect(getKeyboardLayoutSnapshot).toHaveBeenCalled()
    expect(getKeyboardInputSourceId).not.toHaveBeenCalled()
    probe.dispose()
  })

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

  it('invalidates immediately and refreshes on a native layout-change notification', async () => {
    let activeInputSourceId = 'com.apple.keylayout.US'
    let notifyLayoutChanged: (() => void) | undefined
    const unsubscribe = vi.fn()
    const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window, {
      readInputSourceId: async () => activeInputSourceId,
      subscribeKeyboardLayoutChanged: (callback) => {
        notifyLayoutChanged = callback
        return unsubscribe
      }
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')

    activeInputSourceId = 'com.apple.keylayout.ABC'
    notifyLayoutChanged?.()
    expect(probe.getCurrent()).toBe('unknown')
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('non-us')

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
      .mockResolvedValue('com.apple.keylayout.ABC')
    const probe = createOptionAsAltProbe(makeMockWindow(US_MAP) as unknown as Window, {
      readInputSourceId,
      subscribeKeyboardLayoutChanged: (callback) => {
        notifyLayoutChanged = callback
        return vi.fn()
      }
    })

    notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
    finishOldRead('com.apple.keylayout.US')
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
    // ABC and Polish Pro both report a US-identical base layer to
    // getLayoutMap(); without the input-source override they would classify
    // as 'us' → macOptionIsMeta=true and swallow every Option+letter
    // composition (Option+A → å on ABC, ą on Polish Pro).
    for (const id of ['com.apple.keylayout.ABC', 'com.apple.keylayout.PolishPro']) {
      const win = makeMockWindow(US_MAP)
      const probe = createOptionAsAltProbe(win as unknown as Window, {
        readInputSourceId: async () => id
      })
      await probe.refresh()
      expect(probe.getCurrent()).toBe('non-us')
      probe.dispose()
    }
  })

  it('resolves to us when the input source ID is plain US (allowlist match)', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => 'com.apple.keylayout.US'
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')
    probe.dispose()
  })

  it('trusts the input source ID over the fingerprint even when the fingerprint says us', async () => {
    // Pre-fix: the fingerprint's 'us' verdict was authoritative and the
    // macOS ID was ignored, so Turkish-F (which reports US-identical on
    // several keys) plus any US-like fingerprint flipped
    // macOptionIsMeta=true. Now the ID overrides.
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => 'com.apple.keylayout.German'
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })

  it('falls back to the fingerprint when the input-source reader returns null (non-Darwin)', async () => {
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => null
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')
    probe.dispose()
  })

  it('falls back to the fingerprint when the input-source reader throws', async () => {
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
    // Simulate: user boots on US, flips to ABC via the Input Source menu,
    // Orca regains focus. Fingerprint stays US the whole time; the
    // input-source override is what notices the switch.
    let activeInputSourceId: string | null = 'com.apple.keylayout.US'
    const win = makeMockWindow(US_MAP)
    const probe = createOptionAsAltProbe(win as unknown as Window, {
      readInputSourceId: async () => activeInputSourceId
    })
    await probe.refresh()
    expect(probe.getCurrent()).toBe('us')

    activeInputSourceId = 'com.apple.keylayout.ABC'
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

    resolveNew('com.apple.keylayout.ABC')
    await newestProbe
    expect(probe.getCurrent()).toBe('non-us')
    resolveOld('com.apple.keylayout.US')
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.getCurrent()).toBe('non-us')
    probe.dispose()
  })
})
