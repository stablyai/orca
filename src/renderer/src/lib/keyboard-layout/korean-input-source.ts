/**
 * Gate for the terminal Korean Won (₩) → backquote rewrite.
 *
 * The rewrite fires when a Korean keyboard input source is active on macOS:
 * the physical backquote key (kVK_ANSI_Grave, code 'Backquote' — the English
 * QWERTY backquote position) is rewritten to backquote regardless of the
 * character the layout produces there. That one position-based rule covers
 * every Korean layout variant without enumerating them: 두벌식 and 세벌식 390
 * put ₩ there, 세벌식 최종 puts `*`/※, and the English state puts `` ` ``/`~` —
 * none of that matters, the keystroke position alone decides.
 *
 * Why gate on the input source ID at all: the same physical key produces
 * `` ` ``/`~` under the US layout, where the rewrite must not fire. The
 * main-process IPC returns the currently *selected* input source
 * (AppleSelectedInputSources → Input Mode, falling back to
 * AppleCurrentKeyboardLayoutInputSourceID), which resolves to a Korean ID
 * only when a Korean input source is active.
 *
 * Refresh strategy — the gate must track in-place input-source switches:
 * Caps Lock / 한영 keys change the input source while the window keeps focus
 * (no blur/refocus, so focus events alone go stale). Prefetch once at
 * terminal keyboard setup, refresh on window focus-in, AND refresh from
 * keyboard activity: input-toggle keys (CapsLock/Lang1/Lang2) refresh
 * immediately, other keys at most once per cooldown.
 */
type InputSourceIdReader = () => Promise<string | null>

/** Any Korean input method mode: 두벌식 (2SetKorean), 세벌식 390
 *  (390Sebulshik), 세벌식 최종 (3SetKorean), Romaja (HNCRomaja/GJCRomaja),
 *  or the IM bundle itself. */
const KOREAN_INPUT_METHOD_ID_PREFIX = 'com.apple.inputmethod.korean'

/** The shipped Korean keyboard layouts, reported by the fallback branch when
 *  no input method mode is selected. Case-insensitive full-ID match,
 *  deliberately not prefix-matched. */
const KOREAN_KEYLAYOUT_IDS: ReadonlySet<string> = new Set([
  'com.apple.keylayout.2sethangul',
  'com.apple.keylayout.390hangul',
  'com.apple.keylayout.3sethangul',
  'com.apple.keylayout.hncromaja',
  'com.apple.keylayout.gjcromaja'
])

/** Physical keys that switch the macOS input source in place (Caps Lock toggling
 *  to/from ABC, 한/영 and 한자 on Korean keyboards). */
const INPUT_TOGGLE_KEY_CODES: ReadonlySet<string> = new Set(['CapsLock', 'Lang1', 'Lang2'])

const KEYBOARD_ACTIVITY_REFRESH_COOLDOWN_MS = 2000

/** Bounded so a host that never reports an input source costs four probes, not
 *  one per keystroke — each probe spawns `defaults export | plutil | plutil`. */
const INITIAL_PROBE_BACKOFF_MS: readonly number[] = [50, 200, 750]

export function isKoreanInputSourceId(id: string | null | undefined): boolean {
  if (!id) {
    return false
  }
  const normalized = id.toLowerCase()
  return (
    normalized.startsWith(KOREAN_INPUT_METHOD_ID_PREFIX) || KOREAN_KEYLAYOUT_IDS.has(normalized)
  )
}

let cachedIsKorean: boolean | null = null
let refreshGeneration = 0
let lastRefreshAt = 0
let listenerAttached = false
let focusTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null
let focusCallback: (() => void) | null = null
let keyboardActivityCallback: ((event: KeyboardEvent) => void) | null = null

function defaultInputSourceIdReader(): InputSourceIdReader {
  return async () => {
    const api = (
      globalThis as {
        window?: { api?: { app?: { getKeyboardInputSourceId?: () => Promise<string | null> } } }
      }
    ).window?.api
    const reader = api?.app?.getKeyboardInputSourceId
    if (!reader) {
      return null
    }
    try {
      return await reader()
    } catch {
      // Why: the IPC can transiently reject during main-process teardown; treat
      // as no signal so the rewrite stays off instead of guessing.
      return null
    }
  }
}

async function refreshInputSourceId(readInputSourceId: InputSourceIdReader): Promise<void> {
  const generation = ++refreshGeneration
  let id: string | null = null
  try {
    id = await readInputSourceId()
  } catch {
    // Why: keep the last known classification on reader failure rather than
    // dropping layout awareness mid-session.
    return
  }
  if (generation !== refreshGeneration) {
    // Why: a newer refresh superseded this one; committing stale state would
    // misclassify the active input source until the next refresh.
    return
  }
  if (id === null) {
    // Why: the reader returns null for "no signal" (IPC not yet exposed at
    // startup, transient rejection) as well as for a genuinely absent source.
    // Caching that as false turns an unknown into a confirmed negative, which
    // is what left the gate cold for the first keystrokes of a session.
    return
  }
  cachedIsKorean = isKoreanInputSourceId(id)
}

function requestRefresh(readInputSourceId: InputSourceIdReader, force: boolean): void {
  const now = Date.now()
  if (!force && now - lastRefreshAt < KEYBOARD_ACTIVITY_REFRESH_COOLDOWN_MS) {
    return
  }
  lastRefreshAt = now
  void refreshInputSourceId(readInputSourceId)
}

type PrefetchKoreanInputSourceOptions = {
  /** Test-only: window to observe on. Defaults to the global window. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  /** Test-only: injectable input source ID reader. Defaults to the preload IPC. */
  readInputSourceId?: InputSourceIdReader
}

/** Idempotent. Kicks off the initial probe and keeps the cache fresh across
 *  layout switches — on focus-in and on keyboard activity (input-toggle keys
 *  immediately, other keys at most once per cooldown). Call from terminal
 *  keyboard setup so the classification is cached before the user types;
 *  until the probe resolves the gate stays false (strict-until-probe). */
export function prefetchKoreanInputSource(options: PrefetchKoreanInputSourceOptions = {}): void {
  if (listenerAttached) {
    return
  }
  const target = options.win ?? (typeof window === 'undefined' ? null : window)
  if (!target) {
    return
  }
  listenerAttached = true
  focusTarget = target
  const readInputSourceId = options.readInputSourceId ?? defaultInputSourceIdReader()
  focusCallback = () => {
    requestRefresh(readInputSourceId, true)
  }
  keyboardActivityCallback = (event: KeyboardEvent) => {
    requestRefresh(readInputSourceId, INPUT_TOGGLE_KEY_CODES.has(event.code ?? ''))
  }
  target.addEventListener('focus', focusCallback)
  // Why: capture phase so keys pressed inside the terminal still count, and
  // both keydown and keyup so a held toggle key still refreshes on release.
  target.addEventListener('keydown', keyboardActivityCallback, true)
  target.addEventListener('keyup', keyboardActivityCallback, true)
  void runInitialProbe(readInputSourceId, target)
}

/** Why: a keystroke-triggered refresh is async, so it can never classify the
 *  press that triggered it — the cache has to be warm BEFORE the first key. At
 *  startup the IPC is not always exposed yet, so retry with backoff until the
 *  reader yields an ID rather than leaving the gate cold for the session. */
async function runInitialProbe(
  readInputSourceId: InputSourceIdReader,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>
): Promise<void> {
  for (const delayMs of INITIAL_PROBE_BACKOFF_MS) {
    // Why: a reset (or a prefetch onto another window) must stop this loop, or
    // it repopulates the cache the reset just cleared.
    if (!listenerAttached || focusTarget !== target) {
      return
    }
    lastRefreshAt = Date.now()
    await refreshInputSourceId(readInputSourceId)
    if (cachedIsKorean !== null) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  if (!listenerAttached || focusTarget !== target) {
    return
  }
  lastRefreshAt = Date.now()
  await refreshInputSourceId(readInputSourceId)
}

/** Strict gate: only true when the active macOS input source is known to be a
 *  Korean input source. Unknown (probe pending, IPC failure, non-Darwin) stays
 *  false so the rewrite never guesses. */
export function isKoreanInputSourceActive(): boolean {
  return cachedIsKorean === true
}

/** Test-only: seed or clear the cached classification. */
export function _setKoreanInputSourceForTests(value: boolean | null): void {
  cachedIsKorean = value
}

/** Test-only: reset cache, detach listeners, and invalidate any in-flight
 *  refreshes so a stale probe cannot repopulate the cache. */
export function _resetKoreanInputSourceForTests(): void {
  refreshGeneration += 1
  if (focusTarget && focusCallback && keyboardActivityCallback) {
    focusTarget.removeEventListener('focus', focusCallback)
    focusTarget.removeEventListener('keydown', keyboardActivityCallback, true)
    focusTarget.removeEventListener('keyup', keyboardActivityCallback, true)
  }
  focusTarget = null
  focusCallback = null
  keyboardActivityCallback = null
  listenerAttached = false
  cachedIsKorean = null
  lastRefreshAt = 0
}
