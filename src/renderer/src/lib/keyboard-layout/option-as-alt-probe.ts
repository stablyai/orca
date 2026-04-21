/**
 * Runtime probe for the active macOS keyboard layout.
 *
 * Runs detectOptionAsAltFromLayoutMap() at boot and on every window focus-in.
 *
 * Why focus-in and not `layoutchange`: Chromium does not implement the W3C
 * Keyboard API's `layoutchange` event — its Blink IDL exposes only
 * `lock/unlock/getLayoutMap`
 * (chromium/src/third_party/blink/renderer/modules/keyboard/keyboard.idl).
 * Subscribing to `layoutchange` is a no-op. Fortunately every real-world
 * path to switching OS keyboard layout on macOS (Input Menu, Cmd+Space,
 * global shortcut) transfers focus out of Orca and back, so focus-in is a
 * reliable proxy. The only missed case is a layout change triggered by a
 * key pressed while Orca is focused (e.g. a Karabiner rule), which is
 * exceedingly rare and self-heals on the next blur/focus cycle.
 */
import {
  detectOptionAsAltFromLayoutMap,
  type DetectedLayoutCategory,
  type LayoutMapLike
} from './detect-option-as-alt'

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    getLayoutMap: () => Promise<LayoutMapLike>
  }
}

type Listener = (category: DetectedLayoutCategory) => void

export type OptionAsAltProbe = {
  /** Current detected category. Starts `'unknown'` until the first probe
   *  resolves (within a few ms of app boot); listeners fire on every
   *  category change. */
  getCurrent: () => DetectedLayoutCategory
  subscribe: (listener: Listener) => () => void
  /** Force a re-probe. Safe to call from tests or debug tooling. */
  refresh: () => Promise<void>
  /** Detach all window listeners. Tests only. */
  dispose: () => void
}

export function createOptionAsAltProbe(win: Window = window): OptionAsAltProbe {
  let current: DetectedLayoutCategory = 'unknown'
  const listeners = new Set<Listener>()
  let disposed = false

  const notify = (next: DetectedLayoutCategory): void => {
    if (next === current) {
      return
    }
    current = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (err) {
        console.error('[option-as-alt-probe] listener threw:', err)
      }
    }
  }

  const probe = async (): Promise<void> => {
    if (disposed) {
      return
    }
    const nav = win.navigator as NavigatorWithKeyboard
    const keyboard = nav?.keyboard
    if (!keyboard?.getLayoutMap) {
      // Non-Chromium or Electron stripped of the Keyboard API. Stay at
      // 'unknown' → terminal defaults to 'false' (safe for non-US).
      notify('unknown')
      return
    }
    try {
      const map = await keyboard.getLayoutMap()
      if (disposed) {
        return
      }
      notify(detectOptionAsAltFromLayoutMap(map))
    } catch (err) {
      // getLayoutMap can reject in some Chromium corner cases (unavailable
      // permission, transient failure). Log once and keep the last known
      // good value so we don't silently regress a user mid-session.
      console.warn('[option-as-alt-probe] getLayoutMap rejected:', err)
    }
  }

  const onFocus = (): void => {
    void probe()
  }

  win.addEventListener('focus', onFocus)

  // Initial probe. Fire-and-forget; callers subscribe and pick up the
  // result as soon as Chromium's layout map resolves.
  void probe()

  return {
    getCurrent: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: probe,
    dispose: () => {
      disposed = true
      win.removeEventListener('focus', onFocus)
      listeners.clear()
    }
  }
}

/** Singleton probe for the app. Initialized lazily on first getter call so
 *  test environments without a `window` don't trigger side effects at
 *  import time. */
let _singleton: OptionAsAltProbe | null = null

export function getOptionAsAltProbe(): OptionAsAltProbe {
  if (!_singleton) {
    _singleton = createOptionAsAltProbe()
  }
  return _singleton
}

/** Test-only: reset the singleton. */
export function _resetOptionAsAltProbeForTests(): void {
  _singleton?.dispose()
  _singleton = null
}
