// Option chords must resolve against the active layout's character in every dispatcher
// that owns a shortcut, not just the ones traced when the shared matcher gained the lookup.
import { describe, expect, it } from 'vitest'
import {
  keybindingMatchesAction,
  keybindingMatchesInput,
  type KeybindingInput,
  type LayoutCharacterLookup
} from '../../../shared/keybindings'
import {
  matchFloatingWorkspacePanelOwnedAction,
  matchFloatingWorkspacePanelShortcut
} from './floating-workspace-shortcut-policy'

// Dvorak: the key engraved Z on a QWERTY board types ';', and ';' types 'z'.
const dvorakLookup: LayoutCharacterLookup = (code) => {
  if (code === 'KeyZ') {
    return ';'
  }
  if (code === 'Semicolon') {
    return 'z'
  }
  if (code === 'KeyA') {
    return 'a'
  }
  return undefined
}

// macOS reports the composed character for Option chords, leaving no Latin logical key.
function optionChord(overrides: Partial<KeybindingInput>): KeybindingInput {
  return {
    key: 'Ω',
    code: 'KeyZ',
    alt: true,
    control: false,
    meta: false,
    shift: false,
    ...overrides
  } as KeybindingInput
}

describe('editor.toggleWordWrap (Alt+Z) through the shared matcher', () => {
  it('matches the physical Z key when no layout lookup is supplied', () => {
    expect(keybindingMatchesAction('editor.toggleWordWrap', optionChord({}), 'darwin')).toBe(true)
  })

  it('does not match physical Z on Dvorak, where that key types a semicolon', () => {
    expect(
      keybindingMatchesAction('editor.toggleWordWrap', optionChord({}), 'darwin', undefined, {
        layoutCharacterForCode: dvorakLookup
      })
    ).toBe(false)
  })

  it('matches the key that actually types z on Dvorak', () => {
    expect(
      keybindingMatchesAction(
        'editor.toggleWordWrap',
        optionChord({ code: 'Semicolon' }),
        'darwin',
        undefined,
        { layoutCharacterForCode: dvorakLookup }
      )
    ).toBe(true)
  })
})

describe('floating workspace panel dispatcher', () => {
  const maximizeChord = (code: string): KeybindingInput =>
    optionChord({ key: 'Å', code, meta: true, shift: true })

  it('still claims Mod+Alt+Shift+A on QWERTY with the lookup wired in', () => {
    expect(
      matchFloatingWorkspacePanelShortcut(
        { ...maximizeChord('KeyA'), target: null } as never,
        'darwin',
        undefined,
        { context: 'app', layoutCharacterForCode: dvorakLookup }
      )
    ).toEqual({ kind: 'action', action: 'floatingWorkspace.maximize' })
  })

  it('does not claim maximize from a physical A that types another character', () => {
    const swappedLookup: LayoutCharacterLookup = (code) => (code === 'KeyA' ? 'q' : undefined)
    expect(
      matchFloatingWorkspacePanelShortcut(
        { ...maximizeChord('KeyA'), target: null } as never,
        'darwin',
        undefined,
        { context: 'app', layoutCharacterForCode: swappedLookup }
      )
    ).toBeNull()
  })

  it('resolves owned creation chords against the layout character', () => {
    // tab.closeAll is Mod+Alt+W; tab.close (owned) stays Mod+W, so an Option chord
    // on a remapped layout must not resolve through the physical code.
    const remapped = { 'tab.close': ['Alt+Z'] }
    expect(
      matchFloatingWorkspacePanelOwnedAction(
        { ...optionChord({}), target: null } as never,
        'darwin',
        remapped,
        { context: 'app', layoutCharacterForCode: dvorakLookup }
      )
    ).toBeNull()
    expect(
      matchFloatingWorkspacePanelOwnedAction(
        { ...optionChord({ code: 'Semicolon' }), target: null } as never,
        'darwin',
        remapped,
        { context: 'app', layoutCharacterForCode: dvorakLookup }
      )
    ).toBe('tab.close')
  })
})

describe('file explorer copy-path chords', () => {
  // fileExplorer.copyPath is Mod+Alt+C on darwin.
  const copyPathLookup: LayoutCharacterLookup = (code) =>
    code === 'KeyC' ? 'j' : code === 'KeyJ' ? 'c' : undefined

  it('does not match physical C when that key types j', () => {
    expect(
      keybindingMatchesAction(
        'fileExplorer.copyPath',
        optionChord({ key: 'ç', code: 'KeyC', meta: true }),
        'darwin',
        undefined,
        { layoutCharacterForCode: copyPathLookup }
      )
    ).toBe(false)
  })

  it('matches the key that types c on that layout', () => {
    expect(
      keybindingMatchesAction(
        'fileExplorer.copyPath',
        optionChord({ key: 'ç', code: 'KeyJ', meta: true }),
        'darwin',
        undefined,
        { layoutCharacterForCode: copyPathLookup }
      )
    ).toBe(true)
  })
})

describe('plugin command bindings', () => {
  it('resolves a plugin-declared Alt+letter binding through the layout lookup', () => {
    expect(keybindingMatchesInput('Alt+Z', optionChord({}), 'darwin', dvorakLookup)).toBe(false)
    expect(
      keybindingMatchesInput('Alt+Z', optionChord({ code: 'Semicolon' }), 'darwin', dvorakLookup)
    ).toBe(true)
  })
})
