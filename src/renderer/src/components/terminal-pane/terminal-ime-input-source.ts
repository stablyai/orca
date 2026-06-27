import type { IDisposable } from '@xterm/xterm'

export type MacCjkInputSourceTracker = IDisposable & {
  isActive: () => boolean
  refresh: () => Promise<void>
}

type KeyboardInputSourceReader = () => Promise<string | null>

const CJK_INPUT_SOURCE_TERMS = [
  'cangjie',
  'chinese',
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

function defaultKeyboardInputSourceReader(): KeyboardInputSourceReader {
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
      return null
    }
  }
}

export function isMacCjkInputSourceId(id: string | null | undefined): boolean {
  const normalized = id?.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return CJK_INPUT_SOURCE_TERMS.some((term) => normalized.includes(term))
}

export function createMacCjkInputSourceTracker(
  win: Window = window,
  options: { readInputSourceId?: KeyboardInputSourceReader } = {}
): MacCjkInputSourceTracker {
  const readInputSourceId = options.readInputSourceId ?? defaultKeyboardInputSourceReader()
  let active = false
  let disposed = false
  let refreshGeneration = 0

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
    active = isMacCjkInputSourceId(inputSourceId)
  }

  const onFocus = (): void => {
    void refresh()
  }

  win.addEventListener('focus', onFocus)
  void refresh()

  return {
    isActive: () => active,
    refresh,
    dispose: () => {
      disposed = true
      win.removeEventListener('focus', onFocus)
    }
  }
}

let singleton: MacCjkInputSourceTracker | null = null

export function getMacCjkInputSourceTracker(): MacCjkInputSourceTracker {
  singleton ??= createMacCjkInputSourceTracker()
  return singleton
}

export function _resetMacCjkInputSourceTrackerForTests(): void {
  singleton?.dispose()
  singleton = null
}
