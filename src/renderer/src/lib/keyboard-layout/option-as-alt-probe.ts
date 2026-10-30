/** Probe at boot, native input-source changes and focus (browser Keyboard API lacks usable change events). Native identity protects US-shaped composition layouts; missing identity stays conservative on macOS (#1205), with browser fingerprints elsewhere. */
import {
  detectOptionAsAltFromLayoutMap,
  type DetectedLayoutCategory,
  type LayoutMapLike
} from './detect-option-as-alt'
import { classifyInputSourceId } from './input-source-id'
import type { KeyboardLayoutSnapshot } from '../../../../shared/keyboard-layout-snapshot'
import type { KeyboardLayoutChangeEvent } from '../../../../shared/keyboard-layout-events'

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    getLayoutMap: () => Promise<LayoutMapLike>
  }
}

type Listener = (category: DetectedLayoutCategory) => void

type InputSourceIdReader = () => Promise<string | null>
type KeyboardLayoutChangeSubscriber = (
  callback: (event?: KeyboardLayoutChangeEvent) => void
) => () => void

export type OptionAsAltProbe = {
  /** Start unknown until the first probe settles; notify on category changes. */
  getCurrent: () => DetectedLayoutCategory
  subscribe: (listener: Listener) => () => void
  refresh: () => Promise<void>
  dispose: () => void
}

type CreateProbeOptions = {
  /** Inject native source identity for tests; defaults to the preload reader when available. */
  readInputSourceId?: InputSourceIdReader
  subscribeKeyboardLayoutChanged?: KeyboardLayoutChangeSubscriber
}

function defaultKeyboardLayoutChangeSubscriber(): KeyboardLayoutChangeSubscriber {
  return (callback) =>
    (
      globalThis as {
        window?: {
          api?: { app?: { onKeyboardLayoutChanged?: KeyboardLayoutChangeSubscriber } }
        }
      }
    ).window?.api?.app?.onKeyboardLayoutChanged?.(callback) ?? (() => undefined)
}

function defaultInputSourceIdReader(): InputSourceIdReader {
  return async () => {
    const api = (
      globalThis as {
        window?: {
          api?: {
            app?: {
              getKeyboardInputSourceId?: () => Promise<string | null>
              getKeyboardLayoutSnapshot?: () => Promise<KeyboardLayoutSnapshot | null>
            }
          }
        }
      }
    ).window?.api
    const snapshotReader = api?.app?.getKeyboardLayoutSnapshot
    if (snapshotReader) {
      try {
        const snapshot = await snapshotReader()
        if (snapshot?.inputSourceId) {
          return snapshot.inputSourceId
        }
      } catch {
        // Fall through to the preference-backed reader.
      }
    }
    const reader = api?.app?.getKeyboardInputSourceId
    if (!reader) {
      return null
    }
    try {
      return await reader()
    } catch {
      // Missing identity stays conservative on macOS, including during teardown.
      return null
    }
  }
}

export function createOptionAsAltProbe(
  win: Window = window,
  options: CreateProbeOptions = {}
): OptionAsAltProbe {
  let current: DetectedLayoutCategory = 'unknown'
  const listeners = new Set<Listener>()
  let disposed = false
  let probeGeneration = 0
  let layoutChangeGeneration = 0
  let layoutRefreshBlocked = false
  const isMac = win.navigator.userAgent.includes('Mac')
  const readInputSourceId = options.readInputSourceId ?? defaultInputSourceIdReader()
  const subscribeKeyboardLayoutChanged =
    options.subscribeKeyboardLayoutChanged ?? defaultKeyboardLayoutChangeSubscriber()

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
    if (disposed || layoutRefreshBlocked) {
      return
    }
    const generation = ++probeGeneration
    const nav = win.navigator as NavigatorWithKeyboard
    const keyboard = nav?.keyboard

    // Read current-source identity before trusting a potentially IME-backed base layer.
    let inputSourceId: string | null = null
    try {
      inputSourceId = await readInputSourceId()
    } catch {
      // Missing identity stays conservative on macOS.
      inputSourceId = null
    }

    if (disposed || generation !== probeGeneration) {
      return
    }

    // Native input-source identity distinguishes composition layouts with a US-shaped base layer.
    const override = classifyInputSourceId(inputSourceId)
    if (override === 'meta') {
      notify('us')
      return
    }
    if (override === 'compose') {
      notify('non-us')
      return
    }
    if (isMac) {
      notify('unknown')
      return
    }

    if (!keyboard?.getLayoutMap) {
      // Missing browser Keyboard API keeps unknown/composition-safe defaults.
      notify('unknown')
      return
    }
    try {
      const map = await keyboard.getLayoutMap()
      if (disposed || generation !== probeGeneration) {
        return
      }
      notify(detectOptionAsAltFromLayoutMap(map))
    } catch (err) {
      // Log transient layout-map rejection once and retain the last good value to avoid changing behavior mid-session.
      console.warn('[option-as-alt-probe] getLayoutMap rejected:', err)
    }
  }

  const onFocus = (): void => {
    void probe()
  }

  const onKeyboardLayoutChanged = (event?: KeyboardLayoutChangeEvent): void => {
    if (event && event.generation < layoutChangeGeneration) {
      return
    }
    notify('unknown')
    if (event?.phase === 'invalidated') {
      layoutChangeGeneration = event.generation
      layoutRefreshBlocked = true
      ++probeGeneration
      return
    }
    if (event) {
      layoutChangeGeneration = event.generation
    }
    layoutRefreshBlocked = false
    void probe()
  }

  win.addEventListener('focus', onFocus)
  const unsubscribeKeyboardLayoutChanged = subscribeKeyboardLayoutChanged(onKeyboardLayoutChanged)

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
      unsubscribeKeyboardLayoutChanged()
      listeners.clear()
    }
  }
}

/** Create lazily so importing in windowless test environments has no side effects. */
let _singleton: OptionAsAltProbe | null = null

export function getOptionAsAltProbe(): OptionAsAltProbe {
  if (!_singleton) {
    _singleton = createOptionAsAltProbe()
  }
  return _singleton
}
