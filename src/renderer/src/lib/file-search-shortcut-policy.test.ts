// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keybindingMatchesAction } from '../../../shared/keybindings'
import { fileSearchClaimsTextKey } from './file-search-shortcut-policy'

afterEach(() => vi.restoreAllMocks())

describe('file search shortcut ownership', () => {
  it.each(['Macintosh', 'Windows', 'Linux'])(
    'preserves editing and releases app chords on %s',
    (platform) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      const target = document.createElement('input')
      target.setAttribute('data-file-search-input', 'true')
      const modifiers = platform === 'Macintosh' ? { metaKey: true } : { ctrlKey: true }
      for (const key of ['p', 'j', 'b', 'g', '+', '-', 'ArrowUp', 'ArrowDown']) {
        expect(fileSearchClaimsTextKey({ target, key, shiftKey: true, ...modifiers })).toBe(false)
      }
      for (const key of [
        'a',
        'c',
        'v',
        'x',
        'z',
        'y',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'Backspace',
        'Delete'
      ]) {
        expect(fileSearchClaimsTextKey({ target, key, ...modifiers })).toBe(true)
      }
      expect(fileSearchClaimsTextKey({ target, key: 'b' })).toBe(true)
      expect(fileSearchClaimsTextKey({ target, key: 'с', code: 'KeyC', ...modifiers })).toBe(true)
      if (platform !== 'Macintosh') {
        expect(fileSearchClaimsTextKey({ target, key: 'Insert', ...modifiers })).toBe(true)
      }
      expect(fileSearchClaimsTextKey({ target, key: 'p', isComposing: true, ...modifiers })).toBe(
        true
      )
      expect(fileSearchClaimsTextKey({ target, key: 'p', altKey: true, ...modifiers })).toBe(false)
      expect(
        fileSearchClaimsTextKey({ target, key: 'a', code: 'KeyA', altKey: true, ...modifiers })
      ).toBe(false)
      expect(
        fileSearchClaimsTextKey({ target, key: 'r', code: 'KeyR', altKey: true, ...modifiers })
      ).toBe(false)
      expect(fileSearchClaimsTextKey({ target, key: 'a', altKey: true })).toBe(true)
      expect(
        fileSearchClaimsTextKey({
          target,
          key: 'a',
          code: 'KeyA',
          altKey: true,
          altGraph: true,
          ...modifiers
        })
      ).toBe(true)
      expect(
        fileSearchClaimsTextKey({
          target,
          key: 'a',
          altKey: true,
          getModifierState: () => true,
          ...modifiers
        })
      ).toBe(true)
      if (platform !== 'Macintosh') {
        expect(
          keybindingMatchesAction(
            'floatingTerminal.toggle',
            { key: 'a', code: 'KeyA', ctrlKey: true, altKey: true },
            platform === 'Windows' ? 'win32' : 'linux'
          )
        ).toBe(true)
        expect(
          fileSearchClaimsTextKey({ target, key: '@', code: 'KeyQ', altKey: true, ...modifiers })
        ).toBe(true)
      }
      expect(fileSearchClaimsTextKey({ target, key: 'Delete', altKey: true, ...modifiers })).toBe(
        true
      )
      expect(fileSearchClaimsTextKey({ target, key: 'p', ctrlKey: true, metaKey: true })).toBe(true)
    }
  )

  it('retains other text surface authority', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(
        fileSearchClaimsTextKey({ target: document.createElement(tag), key: 'b', metaKey: true })
      ).toBe(true)
    }
    expect(fileSearchClaimsTextKey({ target: document.createElement('button'), key: 'b' })).toBe(
      false
    )
  })
})

it('releases shipped Command+Option actions without reclaiming physical clipboard letters', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  const target = document.createElement('input')
  target.setAttribute('data-file-search-input', 'true')
  for (const [action, key, code] of [
    ['workspace.rename', 'r', 'KeyR'],
    ['floatingTerminal.toggle', 'å', 'KeyA']
  ] as const) {
    const input = { target, key, code, metaKey: true, altKey: true }
    expect(keybindingMatchesAction(action, input, 'darwin')).toBe(true)
    expect(fileSearchClaimsTextKey(input)).toBe(false)
  }
})
