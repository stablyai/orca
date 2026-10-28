import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  applyScreenReaderMode,
  isScreenReaderModeEnabled,
  resolveScreenReaderMode,
  setScreenReaderModePreference,
  watchScreenReaderMode
} from './pane-screen-reader-mode'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

/** The two methods the preload UI bridge contributes, and a record of how they were used. */
function fakeBridge(initial = false): {
  ui: {
    isAccessibilitySupportEnabled: () => Promise<boolean>
    onAccessibilitySupportChanged: (callback: (enabled: boolean) => void) => () => void
  }
  subscriptions: number
  unsubscribes: number
  emit: (enabled: boolean) => void
} {
  const callbacks: ((enabled: boolean) => void)[] = []
  const bridge = {
    ui: {
      isAccessibilitySupportEnabled: () => Promise.resolve(initial),
      onAccessibilitySupportChanged: (callback: (enabled: boolean) => void) => {
        bridge.subscriptions += 1
        callbacks.push(callback)
        return () => {
          bridge.unsubscribes += 1
        }
      }
    },
    subscriptions: 0,
    unsubscribes: 0,
    emit: (enabled: boolean) => {
      for (const callback of callbacks) {
        callback(enabled)
      }
    }
  }
  return bridge
}

afterEach(() => {
  setScreenReaderModePreference('auto')
})

describe('applyScreenReaderMode', () => {
  it('turns xterm accessibility on and off across every live pane', () => {
    const panes = [new Terminal(), new Terminal(), new Terminal()]
    expect(panes.every((terminal) => terminal.options.screenReaderMode !== true)).toBe(true)

    applyScreenReaderMode(panes, true)
    expect(panes.map((terminal) => terminal.options.screenReaderMode)).toEqual([true, true, true])

    applyScreenReaderMode(panes, false)
    expect(panes.map((terminal) => terminal.options.screenReaderMode)).toEqual([
      false,
      false,
      false
    ])
  })

  it('does not rewrite a pane that is already in the right mode', () => {
    const terminal = new Terminal()
    applyScreenReaderMode([terminal], true)
    let writes = 0
    const options = terminal.options
    Object.defineProperty(options, 'screenReaderMode', {
      configurable: true,
      get: () => true,
      set: () => {
        writes += 1
      }
    })
    applyScreenReaderMode([terminal], true)
    // Why it matters: the write rebuilds xterm's accessibility tree, which would yank the rows out
    // from under a screen reader mid-read.
    expect(writes).toBe(0)
  })

  it('seeds a pane opened after the mode was settled', () => {
    setScreenReaderModePreference('on')
    expect(isScreenReaderModeEnabled()).toBe(true)
    expect(buildDefaultTerminalOptions().screenReaderMode).toBe(true)

    setScreenReaderModePreference('off')
    expect(buildDefaultTerminalOptions().screenReaderMode).toBe(false)
  })
})

describe('watchScreenReaderMode', () => {
  /**
   * Every retained tab mounts its own pane host. One listener each would put twenty on a single
   * channel for twenty tabs, past Node's warning threshold and against the listener budget this
   * package pins.
   */
  it('opens one subscription however many pane hosts mount', () => {
    const bridge = fakeBridge()
    const first = new Terminal()
    const second = new Terminal()
    const stopFirst = watchScreenReaderMode(() => [first], bridge.ui)
    const stopSecond = watchScreenReaderMode(() => [second], bridge.ui)
    expect(bridge.subscriptions).toBe(1)

    bridge.emit(true)
    expect(first.options.screenReaderMode).toBe(true)
    expect(second.options.screenReaderMode).toBe(true)

    stopFirst()
    expect(bridge.unsubscribes).toBe(0)
    bridge.emit(false)
    expect(second.options.screenReaderMode).toBe(false)

    stopSecond()
    expect(bridge.unsubscribes).toBe(1)
  })

  it('brings a host that mounts later up to date', () => {
    const bridge = fakeBridge()
    const early = new Terminal()
    const stopEarly = watchScreenReaderMode(() => [early], bridge.ui)
    bridge.emit(true)

    const late = new Terminal()
    const stopLate = watchScreenReaderMode(() => [late], bridge.ui)
    expect(late.options.screenReaderMode).toBe(true)

    stopEarly()
    stopLate()
  })

  /**
   * The seed is a round trip. If a push lands while it is still in flight, the push is newer -- and
   * letting the seed resolve over it would put the panes back to a value the platform has already
   * left, with no further event coming to correct it.
   */
  it('lets a pushed value win over a seed read still in flight', async () => {
    let resolveSeed: ((enabled: boolean) => void) | undefined
    const callbacks: ((enabled: boolean) => void)[] = []
    const ui = {
      isAccessibilitySupportEnabled: () =>
        new Promise<boolean>((resolve) => {
          resolveSeed = resolve
        }),
      onAccessibilitySupportChanged: (callback: (enabled: boolean) => void) => {
        callbacks.push(callback)
        return () => undefined
      }
    }
    const terminal = new Terminal()
    const stop = watchScreenReaderMode(() => [terminal], ui)

    // The push arrives first and turns the rows on.
    for (const callback of callbacks) {
      callback(true)
    }
    expect(terminal.options.screenReaderMode).toBe(true)

    // The seed then answers with what was true before it -- and must not be believed.
    resolveSeed?.(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(terminal.options.screenReaderMode).toBe(true)

    stop()
  })

  it('seeds from the getter, because the app event fired before any pane existed', async () => {
    const bridge = fakeBridge(true)
    const terminal = new Terminal()
    const stop = watchScreenReaderMode(() => [terminal], bridge.ui)
    await vi.waitFor(() => expect(terminal.options.screenReaderMode).toBe(true))
    stop()
  })

  /** The web client and the test renderer both mount panes with no bridge installed. */
  it('mounts without a bridge rather than throwing', () => {
    const terminal = new Terminal()
    const stop = watchScreenReaderMode(() => [terminal], undefined)
    expect(terminal.options.screenReaderMode).toBe(false)
    stop()
  })
})

describe('resolveScreenReaderMode', () => {
  /** The setting exists for the two ends `auto` cannot reach. */
  it('lets the user override the platform in both directions', () => {
    // Linux: Electron reports no assistive client, so `auto` is off and `on` is the way in.
    expect(resolveScreenReaderMode('auto', false)).toBe(false)
    expect(resolveScreenReaderMode('on', false)).toBe(true)
    // macOS: the flag goes true for any accessibility client, so `off` is the way out.
    expect(resolveScreenReaderMode('auto', true)).toBe(true)
    expect(resolveScreenReaderMode('off', true)).toBe(false)
  })

  /** Settings read off an older profile have no value for it. */
  it('treats a missing preference as auto', () => {
    expect(resolveScreenReaderMode(undefined, true)).toBe(true)
    expect(resolveScreenReaderMode(undefined, false)).toBe(false)
  })

  /**
   * Settings come off disk, so the union describes this build and not the file. A value written by
   * a build that spells the option differently still has to resolve to a boolean: `screenReaderMode`
   * is typed one, and `undefined` would reach both the panes and the default options.
   */
  it('treats a value it does not recognise as auto', () => {
    const strange = 'enabled' as unknown as Parameters<typeof resolveScreenReaderMode>[0]
    expect(resolveScreenReaderMode(strange, true)).toBe(true)
    expect(resolveScreenReaderMode(strange, false)).toBe(false)
  })
})

describe('the two inputs together', () => {
  it('re-resolves when the preference changes under a live pane', () => {
    const bridge = fakeBridge()
    const terminal = new Terminal()
    const stop = watchScreenReaderMode(() => [terminal], bridge.ui)

    bridge.emit(true)
    expect(terminal.options.screenReaderMode).toBe(true)

    // Opting out while a client is still attached.
    setScreenReaderModePreference('off')
    expect(terminal.options.screenReaderMode).toBe(false)

    // And back: `auto` returns to what the system says, which is still attached.
    setScreenReaderModePreference('auto')
    expect(terminal.options.screenReaderMode).toBe(true)

    stop()
  })

  it('keeps an explicit On through a client detaching', () => {
    const bridge = fakeBridge()
    const terminal = new Terminal()
    setScreenReaderModePreference('on')
    const stop = watchScreenReaderMode(() => [terminal], bridge.ui)
    expect(terminal.options.screenReaderMode).toBe(true)

    bridge.emit(false)
    expect(terminal.options.screenReaderMode).toBe(true)

    stop()
  })

  /** With the subscription closed nothing reports a detach, so a remembered `true` would be a fact
   *  the module no longer holds. The user's own choice is a setting and does survive. */
  it('forgets the platform flag once the last host leaves, but not the setting', () => {
    const bridge = fakeBridge()
    const stop = watchScreenReaderMode(() => [], bridge.ui)
    bridge.emit(true)
    expect(isScreenReaderModeEnabled()).toBe(true)

    stop()
    expect(isScreenReaderModeEnabled()).toBe(false)

    setScreenReaderModePreference('on')
    const stopAgain = watchScreenReaderMode(() => [], bridge.ui)
    expect(isScreenReaderModeEnabled()).toBe(true)
    stopAgain()
    expect(isScreenReaderModeEnabled()).toBe(true)
  })
})
