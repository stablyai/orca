/**
 * Synchronous lookup of the active keyboard layout's characters with Option absent.
 *
 * Why: kitty keyboard CSI-u reports must carry the codepoint of the key in
 * the *current layout* with no modifiers. Deriving it from the physical code
 * alone assumes US QWERTY and reports the wrong key on Dvorak, Colemak,
 * AZERTY, QWERTZ, etc. — misfiring TUI hotkeys. Chromium supplies the base
 * layer; a native snapshot supplies Shift because the web API omits modifier layers.
 */
import type { LayoutMapLike } from './detect-option-as-alt'
import type {
  KeyboardLayoutKeyCharacters,
  KeyboardLayoutSnapshot
} from '../../../../shared/keyboard-layout-snapshot'
import type { KeyboardLayoutChangeEvent } from '../../../../shared/keyboard-layout-events'

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    getLayoutMap: () => Promise<LayoutMapLike>
  }
}

type LayoutCharacterCache = {
  layoutMap: LayoutMapLike | null
  nativeKeyCharacters: Record<string, KeyboardLayoutKeyCharacters> | null
}

let cachedLayoutCharacters: LayoutCharacterCache = {
  layoutMap: null,
  nativeKeyCharacters: null
}
let focusListenerAttached = false
let attachedWindow: Window | null = null
let unsubscribeLayoutChange: (() => void) | null = null
let refreshGeneration = 0
let layoutChangeGeneration = 0
let layoutRefreshBlocked = false

type KeyboardLayoutAppApi = {
  getKeyboardLayoutSnapshot?: () => Promise<KeyboardLayoutSnapshot | null>
  onKeyboardLayoutChanged?: (callback: (event: KeyboardLayoutChangeEvent) => void) => () => void
}

function getKeyboardLayoutAppApi(): KeyboardLayoutAppApi | undefined {
  return (
    globalThis as {
      window?: { api?: { app?: KeyboardLayoutAppApi } }
    }
  ).window?.api?.app
}

async function refreshLayoutMap(): Promise<void> {
  if (layoutRefreshBlocked) {
    return
  }
  const generation = ++refreshGeneration
  const keyboard = (window.navigator as NavigatorWithKeyboard).keyboard
  const snapshotReader = getKeyboardLayoutAppApi()?.getKeyboardLayoutSnapshot
  const [layoutResult, snapshotResult] = await Promise.allSettled([
    keyboard?.getLayoutMap?.() ?? Promise.resolve(null),
    snapshotReader?.() ?? Promise.resolve(null)
  ])
  if (generation !== refreshGeneration) {
    return
  }
  const layoutMap = layoutResult.status === 'fulfilled' ? layoutResult.value : null
  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null
  const nativeKeyCharacters =
    snapshot && Object.keys(snapshot.keyCharacters).length > 0 ? snapshot.keyCharacters : null
  if (layoutMap || nativeKeyCharacters) {
    cachedLayoutCharacters = { layoutMap, nativeKeyCharacters }
  }
}

function refreshAfterKeyboardLayoutChange(event: KeyboardLayoutChangeEvent): void {
  if (event.generation < layoutChangeGeneration) {
    return
  }
  layoutChangeGeneration = event.generation
  if (event.phase === 'invalidated') {
    layoutRefreshBlocked = true
    cachedLayoutCharacters = { layoutMap: null, nativeKeyCharacters: null }
  } else {
    layoutRefreshBlocked = false
  }
  ++refreshGeneration
  if (event.phase === 'refresh') {
    void refreshLayoutMap()
  }
}

/** Idempotent. Kicks off the initial fetch and keeps the cache fresh across
 *  layout switches. Call from terminal keyboard setup so the map is resolved
 *  before the first Option chord. */
export function prefetchLayoutCharacters(): void {
  if (focusListenerAttached || typeof window === 'undefined') {
    return
  }
  focusListenerAttached = true
  attachedWindow = window
  window.addEventListener('focus', refreshOnFocus)
  unsubscribeLayoutChange =
    getKeyboardLayoutAppApi()?.onKeyboardLayoutChanged?.(refreshAfterKeyboardLayoutChange) ?? null
  void refreshLayoutMap()
}

function refreshOnFocus(): void {
  void refreshLayoutMap()
}

/** A layout map entry is usable as a kitty base key only if it is a single
 *  printable codepoint (dead keys report names like 'Dead'; some entries are
 *  empty). Exposed for tests. */
export function normalizeLayoutBaseCharacter(value: string | undefined): string | undefined {
  return normalizeLayoutCharacter(value?.toLowerCase())
}

function normalizeLayoutCharacter(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const codePoints = [...value]
  if (codePoints.length !== 1) {
    return undefined
  }
  const codePoint = value.codePointAt(0) as number
  return codePoint < 0x20 ? undefined : value
}

/** The active layout's unshifted character for a physical key code, or
 *  undefined when the map is unavailable or the key has no single printable
 *  base character (callers fall back to the US table). */
export function getLayoutBaseCharacterForCode(code: string): string | undefined {
  const nativeCharacters = cachedLayoutCharacters.nativeKeyCharacters
  return normalizeLayoutBaseCharacter(
    nativeCharacters
      ? (nativeCharacters[code]?.unmodified ?? undefined)
      : (cachedLayoutCharacters.layoutMap?.get(code) ?? undefined)
  )
}

/** Character produced by this layout with Shift optionally held and Option absent. */
export function getLayoutCharacterForCode(code: string, shifted: boolean): string | undefined {
  if (!shifted) {
    return getLayoutBaseCharacterForCode(code)
  }
  const nativeShifted = normalizeLayoutCharacter(
    cachedLayoutCharacters.nativeKeyCharacters?.[code]?.shifted
  )
  if (nativeShifted) {
    return nativeShifted
  }
  const base = getLayoutBaseCharacterForCode(code)
  if (!code.startsWith('Key') || !base) {
    return undefined
  }
  return normalizeLayoutCharacter(base.toUpperCase())
}

/** Test-only: replace or clear the cached layout map. */
export function _setLayoutMapForTests(map: LayoutMapLike | null): void {
  cachedLayoutCharacters = { ...cachedLayoutCharacters, layoutMap: map }
}

/** Test-only: replace or clear the native modifier-layer snapshot. */
export function _setLayoutSnapshotForTests(snapshot: KeyboardLayoutSnapshot | null): void {
  cachedLayoutCharacters = {
    ...cachedLayoutCharacters,
    nativeKeyCharacters: snapshot?.keyCharacters ?? null
  }
}

export const _refreshLayoutCharactersForTests = refreshLayoutMap

export function _resetLayoutCharacterListenersForTests(): void {
  attachedWindow?.removeEventListener('focus', refreshOnFocus)
  unsubscribeLayoutChange?.()
  attachedWindow = null
  unsubscribeLayoutChange = null
  focusListenerAttached = false
  layoutChangeGeneration = 0
  layoutRefreshBlocked = false
  ++refreshGeneration
}
