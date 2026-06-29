import type { IDisposable } from '@xterm/xterm'

export type MacNativeTextInputSourceFeatures = Readonly<{
  forwardAsciiPunctuation: boolean
  forwardShortTextReplacements: boolean
}>

export type MacNativeTextInputSourceTracker = IDisposable & {
  isActive: () => boolean
  getFeatures: () => MacNativeTextInputSourceFeatures
  refresh: () => Promise<void>
}

type KeyboardInputSourceReader = () => Promise<string | null>

export const DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES = Object.freeze({
  forwardAsciiPunctuation: false,
  forwardShortTextReplacements: false
}) satisfies MacNativeTextInputSourceFeatures

const CJK_NATIVE_TEXT_INPUT_SOURCE_FEATURES = Object.freeze({
  forwardAsciiPunctuation: true,
  forwardShortTextReplacements: false
}) satisfies MacNativeTextInputSourceFeatures

const VIETNAMESE_NATIVE_TEXT_INPUT_SOURCE_FEATURES = Object.freeze({
  forwardAsciiPunctuation: false,
  forwardShortTextReplacements: true
}) satisfies MacNativeTextInputSourceFeatures

const CJK_INPUT_SOURCE_TERMS = [
  'bytedance',
  'cangjie',
  'chinese',
  'doubao',
  'hangul',
  'hanin',
  'hiragana',
  'itabc',
  'japanese',
  'kana',
  'katakana',
  'korean',
  'kotoeri',
  'pinyin',
  'rime',
  'romaji',
  'scim',
  'shuangpin',
  'stroke',
  'tcim',
  'wubi',
  'wubihua',
  'zhuyin'
] as const

const VIETNAMESE_INPUT_SOURCE_TERMS = ['telex', 'unikey', 'vietnam', 'vni'] as const

const KEYBOARD_ACTIVITY_REFRESH_COOLDOWN_MS = 1000

function defaultKeyboardInputSourceReader(): KeyboardInputSourceReader {
  return async () => {
    const api = (
      globalThis as {
        window?: {
          api?: {
            app?: {
              getKeyboardInputSourceId?: () => Promise<string | null>
            }
          }
        }
      }
    ).window?.api
    const reader = api?.app?.getKeyboardInputSourceId
    if (!reader) {
      return null
    }
    try {
      return await reader()
    } catch {
      return null
    }
  }
}

export function getMacNativeTextInputSourceFeatures(
  id: string | null | undefined
): MacNativeTextInputSourceFeatures {
  const normalized = id?.trim().toLowerCase()
  if (!normalized) {
    return DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES
  }
  if (CJK_INPUT_SOURCE_TERMS.some((term) => normalized.includes(term))) {
    return CJK_NATIVE_TEXT_INPUT_SOURCE_FEATURES
  }
  if (VIETNAMESE_INPUT_SOURCE_TERMS.some((term) => normalized.includes(term))) {
    return VIETNAMESE_NATIVE_TEXT_INPUT_SOURCE_FEATURES
  }
  return DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES
}

export function createMacNativeTextInputSourceTracker(
  win: Window = window,
  options: { readInputSourceId?: KeyboardInputSourceReader } = {}
): MacNativeTextInputSourceTracker {
  const readInputSourceId = options.readInputSourceId ?? defaultKeyboardInputSourceReader()
  let features: MacNativeTextInputSourceFeatures = DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES
  let disposed = false
  let refreshGeneration = 0
  let refreshInFlight = false
  let refreshQueued = false
  let lastKeyboardActivityRefreshAt: number | null = null

  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    let inputSourceId: string | null = null
    try {
      inputSourceId = await readInputSourceId()
    } catch {
      inputSourceId = null
    }
    if (disposed || generation !== refreshGeneration) {
      return
    }
    features = getMacNativeTextInputSourceFeatures(inputSourceId)
  }

  const requestRefresh = (): void => {
    if (refreshInFlight) {
      refreshQueued = true
      return
    }
    refreshInFlight = true
    void refresh().finally(() => {
      refreshInFlight = false
      if (!disposed && refreshQueued) {
        refreshQueued = false
        requestRefresh()
      }
    })
  }

  const onFocus = (): void => {
    requestRefresh()
  }

  const requestKeyboardActivityRefresh = (force: boolean): void => {
    const now = Date.now()
    if (
      !force &&
      lastKeyboardActivityRefreshAt !== null &&
      now - lastKeyboardActivityRefreshAt < KEYBOARD_ACTIVITY_REFRESH_COOLDOWN_MS
    ) {
      return
    }
    lastKeyboardActivityRefreshAt = now
    requestRefresh()
  }

  const onKeyboardActivity = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      requestKeyboardActivityRefresh(true)
      return
    }
    if (!features.forwardAsciiPunctuation && !features.forwardShortTextReplacements) {
      requestKeyboardActivityRefresh(false)
    }
  }

  win.addEventListener('focus', onFocus)
  // Why: macOS input-source changes can happen while the terminal keeps focus;
  // refresh from keyboard activity so CJK punctuation gates do not stay stale.
  win.addEventListener('keydown', onKeyboardActivity, true)
  win.addEventListener('keyup', onKeyboardActivity, true)
  requestRefresh()

  return {
    isActive: () => features.forwardAsciiPunctuation || features.forwardShortTextReplacements,
    getFeatures: () => features,
    refresh,
    dispose: () => {
      disposed = true
      win.removeEventListener('focus', onFocus)
      win.removeEventListener('keydown', onKeyboardActivity, true)
      win.removeEventListener('keyup', onKeyboardActivity, true)
    }
  }
}

let singleton: MacNativeTextInputSourceTracker | null = null

export function getMacNativeTextInputSourceTracker(): MacNativeTextInputSourceTracker {
  singleton ??= createMacNativeTextInputSourceTracker()
  return singleton
}

export function _resetMacNativeTextInputSourceTrackerForTests(): void {
  singleton?.dispose()
  singleton = null
}
