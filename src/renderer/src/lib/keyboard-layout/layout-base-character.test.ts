import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _refreshLayoutCharactersForTests,
  _resetLayoutCharacterListenersForTests,
  _setLayoutMapForTests,
  _setLayoutSnapshotForTests,
  getLayoutBaseCharacterForCode,
  prefetchLayoutCharacters
} from './layout-base-character'

import type { KeyboardLayoutSnapshot } from '../../../../shared/keyboard-layout-snapshot'
import type { KeyboardLayoutChangeEvent } from '../../../../shared/keyboard-layout-events'

describe('getLayoutBaseCharacterForCode', () => {
  afterEach(() => {
    _setLayoutMapForTests(null)
    _setLayoutSnapshotForTests(null)
    _resetLayoutCharacterListenersForTests()
    vi.unstubAllGlobals()
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
