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
})
