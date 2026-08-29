/**
 * Runtime probe for the active macOS keyboard layout.
 *
 * Runs at boot, on native macOS input-source notifications, and on focus as a
 * fallback. The browser Keyboard API has no usable layout-change event.
 *
 * Why two signals (input source ID + fingerprint): the fingerprint can
 * only see the base (unshifted) layer, which is identical to US QWERTY
 * on a large set of Apple-shipped layouts — ABC, Polish Pro, US
 * Extended, ABC Extended, and every CJK Roman IME all trap on it. They
 * repurpose Option for dead-key composition (Option+A → å / ą), so
 * trusting the fingerprint alone makes macOptionIsMeta=true and
 * silently swallows those characters (issue #1205). On macOS we treat
 * the input source ID as authoritative and only fall back to the
 * fingerprint when the ID is unavailable (non-Darwin, sandboxed
 * defaults, IPC failure). See ./input-source-id.ts for the allowlist.
 */
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

type CreateProbeOptions = {
  /** Injectable reader for the macOS input source ID. Defaults to the
   *  preload `window.api.app.getKeyboardInputSourceId` when available.
   *  Tests pass a stub to exercise the compose override deterministically. */
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
      // Why: the IPC can transiently reject during main-process teardown
      // (e.g. app quitting mid-probe). Treat as no signal so the
      // fingerprint remains the sole input.
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

    // Why: read the input-source ID first. On macOS this resolves to a
    // concrete ID (e.g. com.apple.keylayout.ABC); on every other platform
    // it resolves to null and we fall through to the fingerprint.
    let inputSourceId: string | null = null
    try {
      inputSourceId = await readInputSourceId()
    } catch {
      // Treat errors as no signal — the fingerprint still runs below.
      inputSourceId = null
    }

    if (disposed || generation !== probeGeneration) {
      return
    }

    // Why: when macOS returns a concrete input source ID, it's authoritative.
    // The fingerprint can only see the base (unshifted) layer, which is
    // US-identical on ABC, Polish Pro, US Extended, ABC Extended, and every
    // CJK Roman IME — so trusting it flips macOptionIsMeta=true on all of
    // them and silently swallows Option+letter compositions (#1205). The
    // Only the two known Option-as-Meta layouts are allowed; every other
    // concrete input source keeps Option available for composition.
    const override = classifyInputSourceId(inputSourceId)
    if (override === 'meta') {
      notify('us')
      return
    }
    if (override === 'compose') {
      notify('non-us')
      return
    }

    if (!keyboard?.getLayoutMap) {
      // Non-Chromium or Electron stripped of the Keyboard API. Stay at
      // 'unknown' → terminal defaults to 'false' (safe for non-US).
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
      // getLayoutMap can reject in some Chromium corner cases (unavailable
      // permission, transient failure). Log once and keep the last known
      // good value so we don't silently regress a user mid-session.
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
      unsubscribeKeyboardLayoutChanged()
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
