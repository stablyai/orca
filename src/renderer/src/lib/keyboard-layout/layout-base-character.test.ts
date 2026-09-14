import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _refreshLayoutCharactersForTests,
  _resetLayoutCharacterListenersForTests,
  _setLayoutMapForTests,
  _setLayoutSnapshotForTests,
  getLayoutBaseCharacterForCode,
  getLayoutCharacterForCode,
  normalizeLayoutBaseCharacter,
  prefetchLayoutCharacters
} from './layout-base-character'
import type { KeyboardLayoutSnapshot } from '../../../../shared/keyboard-layout-snapshot'
import type { KeyboardLayoutChangeEvent } from '../../../../shared/keyboard-layout-events'

describe('normalizeLayoutBaseCharacter', () => {
  it('accepts a single printable codepoint, lowercased', () => {
    expect(normalizeLayoutBaseCharacter('p')).toBe('p')
    expect(normalizeLayoutBaseCharacter('P')).toBe('p')
    expect(normalizeLayoutBaseCharacter('ö')).toBe('ö')
    expect(normalizeLayoutBaseCharacter(';')).toBe(';')
    expect(normalizeLayoutBaseCharacter(' ')).toBe(' ')
  })

  it('rejects empty, named-key, multi-codepoint, and control values', () => {
    expect(normalizeLayoutBaseCharacter(undefined)).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('')).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('Dead')).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('İ')).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('\t')).toBeUndefined()
  })
})

describe('getLayoutBaseCharacterForCode', () => {
  afterEach(() => {
    _setLayoutMapForTests(null)
    _setLayoutSnapshotForTests(null)
    _resetLayoutCharacterListenersForTests()
    vi.unstubAllGlobals()
  })

  it('returns undefined without a cached map, and resolves through one', () => {
    expect(getLayoutBaseCharacterForCode('KeyP')).toBeUndefined()

    const azertyEntries = new Map([
      ['Semicolon', 'm'],
      ['KeyE', 'Dead']
    ])
    _setLayoutMapForTests({
      get: (code) => azertyEntries.get(code),
      size: azertyEntries.size
    })
    expect(getLayoutBaseCharacterForCode('Semicolon')).toBe('m')
    expect(getLayoutBaseCharacterForCode('KeyE')).toBeUndefined()
    expect(getLayoutBaseCharacterForCode('KeyZ')).toBeUndefined()
  })

  it('uses the native Shift layer and falls back safely', () => {
    _setLayoutMapForTests({ get: (code) => (code === 'Digit2' ? '2' : 'q'), size: 2 })
    _setLayoutSnapshotForTests({
      inputSourceId: 'com.apple.keylayout.Latvian',
      keyCharacters: {
        Digit2: {
          unmodified: '2',
          shifted: '@'
        },
        KeyQ: { unmodified: 'q', shifted: 'Q' }
      }
    })

    expect(getLayoutCharacterForCode('Digit2', false)).toBe('2')
    expect(getLayoutCharacterForCode('Digit2', true)).toBe('@')
    expect(getLayoutCharacterForCode('KeyQ', true)).toBe('Q')

    _setLayoutSnapshotForTests(null)
    // Without the native snapshot only Key* codes can be uppercased physically.
    expect(getLayoutCharacterForCode('Digit2', true)).toBeUndefined()
    expect(getLayoutCharacterForCode('KeyQ', true)).toBe('Q')
  })

  it('keeps the last complete snapshot until an atomic refresh settles', async () => {
    _setLayoutSnapshotForTests({
      inputSourceId: 'old',
      keyCharacters: {
        Digit7: { unmodified: '7', shifted: '/' }
      }
    })
    let resolveMap!: (map: { get: (code: string) => string | undefined; size: number }) => void
    let resolveSnapshot!: (snapshot: {
      inputSourceId: string
      keyCharacters: Record<
        string,
        {
          unmodified: string
          shifted: string
        }
      >
    }) => void
    const mapPromise = new Promise<{
      get: (code: string) => string | undefined
      size: number
    }>((resolve) => {
      resolveMap = resolve
    })
    const snapshotPromise = new Promise<Parameters<typeof resolveSnapshot>[0]>((resolve) => {
      resolveSnapshot = resolve
    })
    vi.stubGlobal('window', {
      navigator: { keyboard: { getLayoutMap: () => mapPromise } },
      api: { app: { getKeyboardLayoutSnapshot: () => snapshotPromise } }
    })

    const refresh = _refreshLayoutCharactersForTests()
    expect(getLayoutCharacterForCode('Digit7', true)).toBe('/')
    resolveMap({ get: () => '&', size: 1 })
    await Promise.resolve()
    expect(getLayoutCharacterForCode('Digit7', true)).toBe('/')
    resolveSnapshot({
      inputSourceId: 'new',
      keyCharacters: {
        Digit7: { unmodified: '7', shifted: '?' }
      }
    })
    await refresh
    expect(getLayoutCharacterForCode('Digit7', true)).toBe('?')
  })

  it('never combines a native snapshot with a separate layout-map fallback', () => {
    _setLayoutMapForTests({ get: () => 'q', size: 1 })
    _setLayoutSnapshotForTests({
      inputSourceId: 'partial',
      keyCharacters: {
        Digit7: { unmodified: '7', shifted: '/' }
      }
    })

    expect(getLayoutBaseCharacterForCode('KeyQ')).toBeUndefined()
  })

  it('invalidates synchronously and fences an older refresh after a layout change', async () => {
    _setLayoutSnapshotForTests({
      inputSourceId: 'old',
      keyCharacters: {
        KeyQ: { unmodified: 'q', shifted: 'Q' }
      }
    })
    let notifyLayoutChanged: ((event: KeyboardLayoutChangeEvent) => void) | undefined
    let focusListener: (() => void) | undefined
    let resolveOldSnapshot!: (snapshot: KeyboardLayoutSnapshot) => void
    let resolveNewSnapshot!: (snapshot: KeyboardLayoutSnapshot) => void
    const oldSnapshot = new Promise<KeyboardLayoutSnapshot>((resolve) => {
      resolveOldSnapshot = resolve
    })
    const newSnapshot = new Promise<KeyboardLayoutSnapshot>((resolve) => {
      resolveNewSnapshot = resolve
    })
    const getKeyboardLayoutSnapshot = vi
      .fn<() => Promise<KeyboardLayoutSnapshot>>()
      .mockReturnValueOnce(oldSnapshot)
      .mockReturnValueOnce(newSnapshot)
    vi.stubGlobal('window', {
      navigator: { keyboard: { getLayoutMap: async () => null } },
      api: {
        app: {
          getKeyboardLayoutSnapshot,
          onKeyboardLayoutChanged: (callback: (event: KeyboardLayoutChangeEvent) => void) => {
            notifyLayoutChanged = callback
            return vi.fn()
          }
        }
      },
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'focus') {
          focusListener = listener
        }
      }),
      removeEventListener: vi.fn()
    })

    prefetchLayoutCharacters()
    notifyLayoutChanged?.({ phase: 'invalidated', generation: 1 })
    expect(getLayoutBaseCharacterForCode('KeyQ')).toBeUndefined()
    focusListener?.()
    await _refreshLayoutCharactersForTests()
    expect(getKeyboardLayoutSnapshot).toHaveBeenCalledOnce()

    resolveOldSnapshot({
      inputSourceId: 'stale',
      keyCharacters: {
        KeyQ: { unmodified: 'x', shifted: 'X' }
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(getLayoutBaseCharacterForCode('KeyQ')).toBeUndefined()

    notifyLayoutChanged?.({ phase: 'refresh', generation: 1 })

    resolveNewSnapshot({
      inputSourceId: 'new',
      keyCharacters: {
        KeyQ: { unmodified: 'a', shifted: 'A' }
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(getLayoutBaseCharacterForCode('KeyQ')).toBe('a')
  })
})
