// Terminal shortcut resolution must consult the active layout for Option chords, which
// macOS reports as composed characters with no Latin logical key.
import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('resolveTerminalShortcutAction layout-aware Option chords', () => {
  // Dvorak: physical Z types ';' and physical Semicolon types 'z'.
  const dvorakLayoutCharacter = (code: string, shifted: boolean): string | undefined => {
    if (shifted) {
      return undefined
    }
    if (code === 'KeyZ') {
      return ';'
    }
    if (code === 'Semicolon') {
      return 'z'
    }
    return undefined
  }

  const optionChord = (code: string): TerminalShortcutEvent =>
    event({ key: 'Ω', code, altKey: true })

  const remappedSearch = { 'terminal.search': ['Alt+Z'] }

  function resolveWithLayout(
    input: TerminalShortcutEvent,
    layout?: (code: string, shifted: boolean) => string | undefined
  ): ReturnType<typeof resolveTerminalShortcutAction> {
    return resolveTerminalShortcutAction(
      input,
      true,
      'false',
      0,
      false,
      remappedSearch,
      undefined,
      undefined,
      layout
    )
  }

  it('matches an Option chord by physical code when no layout lookup is supplied', () => {
    expect(resolveWithLayout(optionChord('KeyZ'))).toEqual({ type: 'toggleSearch' })
  })

  it('does not match physical Z on Dvorak, where that key types a semicolon', () => {
    expect(resolveWithLayout(optionChord('KeyZ'), dvorakLayoutCharacter)).not.toEqual({
      type: 'toggleSearch'
    })
  })

  it('matches the key that actually types z on Dvorak', () => {
    expect(resolveWithLayout(optionChord('Semicolon'), dvorakLayoutCharacter)).toEqual({
      type: 'toggleSearch'
    })
  })
})
