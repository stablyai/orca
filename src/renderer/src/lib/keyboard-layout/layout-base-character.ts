/**
 * Synchronous lookup of the active keyboard layout's base (unshifted)
 * character for a physical `KeyboardEvent.code`.
 *
 * Why: kitty keyboard CSI-u reports must carry the codepoint of the key in
 * the *current layout* with no modifiers. Deriving it from the physical code
 * alone assumes US QWERTY and reports the wrong key on Dvorak, Colemak,
 * AZERTY, QWERTZ, etc. — misfiring TUI hotkeys. Chromium's KeyboardLayoutMap
 * is the layout-true source, but it resolves asynchronously, so this module
 * prefetches it and refreshes on window focus-in (every macOS layout-switch
 * path blurs and refocuses the window; Chromium has no layoutchange event —
 * see option-as-alt-probe.ts).
 */
import type { LayoutMapLike } from './detect-option-as-alt'

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    getLayoutMap: () => Promise<LayoutMapLike>
  }
}

let cachedLayoutMap: LayoutMapLike | null = null
let focusListenerAttached = false

async function refreshLayoutMap(): Promise<void> {
  const keyboard = (window.navigator as NavigatorWithKeyboard).keyboard
  if (!keyboard?.getLayoutMap) {
    return
  }
  try {
    cachedLayoutMap = await keyboard.getLayoutMap()
  } catch {
    // Why: getLayoutMap can transiently reject; keep the last known map
    // instead of dropping layout awareness mid-session.
  }
}

/** Idempotent. Kicks off the initial fetch and keeps the cache fresh across
 *  layout switches. Call from terminal keyboard setup so the map is resolved
 *  before the first Option chord. */
export function prefetchLayoutBaseCharacters(): void {
  if (focusListenerAttached || typeof window === 'undefined') {
    return
  }
  focusListenerAttached = true
  window.addEventListener('focus', () => {
    void refreshLayoutMap()
  })
  void refreshLayoutMap()
}

/** A layout map entry is usable as a kitty base key only if it is a single
 *  printable codepoint (dead keys report names like 'Dead'; some entries are
 *  empty). Exposed for tests. */
export function normalizeLayoutBaseCharacter(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const lowered = value.toLowerCase()
  const codePoints = [...lowered]
  if (codePoints.length !== 1) {
    return undefined
  }
  const codePoint = lowered.codePointAt(0) as number
  return codePoint <= 0x20 ? undefined : lowered
}

/** The active layout's unshifted character for a physical key code, or
 *  undefined when the map is unavailable or the key has no single printable
 *  base character (callers fall back to the US table). */
export function getLayoutBaseCharacterForCode(code: string): string | undefined {
  return normalizeLayoutBaseCharacter(cachedLayoutMap?.get(code))
}

/** Test-only: replace or clear the cached layout map. */
export function _setLayoutMapForTests(map: LayoutMapLike | null): void {
  cachedLayoutMap = map
}
