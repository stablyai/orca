import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createOptionAsAltProbe } from './option-as-alt-probe'
import type { LayoutMapLike } from './detect-option-as-alt'

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
})
