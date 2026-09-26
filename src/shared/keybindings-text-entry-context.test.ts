// Text-entry focus context: which chords a declared text surface hands to the app.
import { describe, expect, it } from 'vitest'
import {
  isChordReservedForTextEntry,
  keybindingMatchesAction,
  type KeybindingInput,
  type TextEntryClaim
} from './keybindings'

const SINGLE_LINE: TextEntryClaim = { verticalCaret: false, richTextFormatting: false }
const MULTILINE: TextEntryClaim = { verticalCaret: true, richTextFormatting: false }
const RICH_TEXT: TextEntryClaim = { verticalCaret: true, richTextFormatting: true }

function chord(key: string, code: string, extra: Partial<KeybindingInput> = {}): KeybindingInput {
  return { key, code, meta: false, control: false, alt: false, shift: false, ...extra }
}

const modShiftArrowUp = (mac: boolean): KeybindingInput =>
  chord('ArrowUp', 'ArrowUp', { shift: true, meta: mac, control: !mac })
const modShiftBackspace = (mac: boolean): KeybindingInput =>
  chord('Backspace', 'Backspace', { shift: true, meta: mac, control: !mac })
const modB = (mac: boolean): KeybindingInput => chord('b', 'KeyB', { meta: mac, control: !mac })

describe('text-entry keybinding context', () => {
  const platformCases: readonly (readonly [NodeJS.Platform, boolean])[] = [
    ['darwin', true],
    ['linux', false],
    ['win32', false]
  ]

  it.each(platformCases)(
    'lets a single-line field hand Mod+Shift+ArrowUp to worktree navigation on %s',
    (platform, mac) => {
      const input = modShiftArrowUp(mac)

      expect(keybindingMatchesAction('worktree.navigateUp', input, platform)).toBe(true)
      expect(
        keybindingMatchesAction('worktree.navigateUp', input, platform, undefined, {
          context: 'text-entry',
          textEntryClaim: SINGLE_LINE
        })
      ).toBe(true)
      expect(
        keybindingMatchesAction('worktree.navigateUp', input, platform, undefined, {
          context: 'text-entry',
          textEntryClaim: MULTILINE
        })
      ).toBe(false)
    }
  )

  it('assumes the strictest claim when the caller names no surface', () => {
    expect(
      keybindingMatchesAction('worktree.navigateUp', modShiftArrowUp(true), 'darwin', undefined, {
        context: 'text-entry'
      })
    ).toBe(false)
  })

  it('keeps deletion chords with the text surface', () => {
    expect(
      keybindingMatchesAction('workspace.delete', modShiftBackspace(true), 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: SINGLE_LINE
      })
    ).toBe(false)
  })

  it('keeps Mod+B with a rich-text editor but not with a plain field', () => {
    expect(
      keybindingMatchesAction('sidebar.left.toggle', modB(true), 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: RICH_TEXT
      })
    ).toBe(false)
    expect(
      keybindingMatchesAction('sidebar.left.toggle', modB(true), 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: SINGLE_LINE
      })
    ).toBe(true)
  })

  it('never hands a non-global scope to a text surface', () => {
    const modW = chord('w', 'KeyW', { meta: true })

    expect(keybindingMatchesAction('tab.close', modW, 'darwin')).toBe(true)
    expect(
      keybindingMatchesAction('tab.close', modW, 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: SINGLE_LINE
      })
    ).toBe(false)
  })

  it('leaves app, terminal and browser contexts untouched', () => {
    const modP = chord('p', 'KeyP', { meta: true })

    expect(keybindingMatchesAction('worktree.quickOpen', modP, 'darwin')).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', modP, 'darwin', undefined, { context: 'app' })
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', modP, 'darwin', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
  })
})

describe('isChordReservedForTextEntry', () => {
  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'])(
    'reserves %s for every text surface',
    (key) => {
      expect(isChordReservedForTextEntry(chord(key, key), SINGLE_LINE, 'darwin')).toBe(true)
    }
  )

  it.each(['a', 'c', 'v', 'x', 'z', 'y'])('reserves the Mod+%s text command', (key) => {
    expect(
      isChordReservedForTextEntry(
        chord(key, `Key${key.toUpperCase()}`, { meta: true }),
        SINGLE_LINE,
        'darwin'
      )
    ).toBe(true)
  })

  it('reserves redo but not a Shift-modified formatting chord', () => {
    expect(
      isChordReservedForTextEntry(
        chord('z', 'KeyZ', { meta: true, shift: true }),
        SINGLE_LINE,
        'darwin'
      )
    ).toBe(true)
    expect(
      isChordReservedForTextEntry(
        chord('b', 'KeyB', { meta: true, shift: true }),
        RICH_TEXT,
        'darwin'
      )
    ).toBe(false)
  })

  it('reads the primary modifier per platform', () => {
    const ctrlC = chord('c', 'KeyC', { control: true })

    // Ctrl is the primary modifier off macOS, so Ctrl+C is the surface's copy chord there.
    expect(isChordReservedForTextEntry(ctrlC, SINGLE_LINE, 'linux')).toBe(true)
    // On macOS copy is Cmd+C, and AppKit binds no ^c, so Ctrl+C is not a text gesture.
    expect(isChordReservedForTextEntry(ctrlC, SINGLE_LINE, 'darwin')).toBe(false)
    expect(
      isChordReservedForTextEntry(chord('c', 'KeyC', { meta: true }), SINGLE_LINE, 'darwin')
    ).toBe(true)
  })

  // AppKit's StandardKeyBinding.dict binds these in every macOS text view, so they are
  // text gestures there even though Ctrl is not the platform's primary modifier.
  it.each(['a', 'b', 'd', 'e', 'f', 'h', 'k', 'o', 't', 'y'])(
    'reserves macOS Ctrl+%s for any text surface',
    (letter) => {
      const ctrlLetter = chord(letter, `Key${letter.toUpperCase()}`, { control: true })

      expect(isChordReservedForTextEntry(ctrlLetter, SINGLE_LINE, 'darwin')).toBe(true)
    }
  )

  it('reserves the Shift variant that extends the selection', () => {
    const ctrlShiftE = chord('E', 'KeyE', { control: true, shift: true })

    expect(isChordReservedForTextEntry(ctrlShiftE, SINGLE_LINE, 'darwin')).toBe(true)
  })

  it.each(['n', 'p', 'v'])(
    'reserves macOS Ctrl+%s only where the caret moves vertically',
    (letter) => {
      const ctrlLetter = chord(letter, `Key${letter.toUpperCase()}`, { control: true })

      expect(isChordReservedForTextEntry(ctrlLetter, MULTILINE, 'darwin')).toBe(true)
      expect(isChordReservedForTextEntry(ctrlLetter, SINGLE_LINE, 'darwin')).toBe(false)
    }
  )

  it('leaves macOS Ctrl+L to the app: it recenters the view, not the caret', () => {
    expect(
      isChordReservedForTextEntry(chord('l', 'KeyL', { control: true }), RICH_TEXT, 'darwin')
    ).toBe(false)
  })

  it('keeps the macOS Ctrl rules off Windows and Linux, where Ctrl is the primary modifier', () => {
    const ctrlE = chord('e', 'KeyE', { control: true })

    // Mod+E is Orca's dictation chord there; only macOS binds Ctrl+E to text editing.
    expect(isChordReservedForTextEntry(ctrlE, SINGLE_LINE, 'linux')).toBe(false)
    expect(isChordReservedForTextEntry(ctrlE, SINGLE_LINE, 'win32')).toBe(false)
    expect(isChordReservedForTextEntry(ctrlE, SINGLE_LINE, 'darwin')).toBe(true)
    // Ctrl+A stays reserved off macOS through the primary-modifier rule, not this one.
    expect(
      isChordReservedForTextEntry(chord('a', 'KeyA', { control: true }), SINGLE_LINE, 'linux')
    ).toBe(true)
  })

  // AppKit's only Option+Ctrl text chords: ~^b / ~^f move by word.
  it.each([
    ['b', 'B', '\u222b'],
    ['f', 'F', '\u0192']
  ])('reserves macOS Ctrl+Option+%s, which reports a composed key', (_letter, code, composed) => {
    // macOS reports the Option-composed character, so the physical code is what identifies it.
    const wordMove = chord(composed, `Key${code}`, { control: true, alt: true })
    const extendSelection = chord(composed, `Key${code}`, {
      control: true,
      alt: true,
      shift: true
    })

    expect(isChordReservedForTextEntry(wordMove, SINGLE_LINE, 'darwin')).toBe(true)
    expect(isChordReservedForTextEntry(extendSelection, SINGLE_LINE, 'darwin')).toBe(true)
  })

  it('keeps Option out of the rest of the macOS Ctrl family', () => {
    // AppKit binds no ~^a, so the chord stays available to the app.
    const ctrlOptionA = chord('\u00e5', 'KeyA', { control: true, alt: true })

    expect(isChordReservedForTextEntry(ctrlOptionA, RICH_TEXT, 'darwin')).toBe(false)
  })

  it('resolves a non-Latin layout through the physical code', () => {
    // A Russian layout reports Cyrillic es for the physical C key; the copy chord is still
    // the surface's, and the matcher resolves the binding the same way.
    const cyrillicCtrlC = chord('\u0441', 'KeyC', { control: true })

    expect(isChordReservedForTextEntry(cyrillicCtrlC, SINGLE_LINE, 'linux')).toBe(true)
  })

  it('reserves the legacy Insert clipboard chords off macOS only', () => {
    const ctrlInsert = chord('Insert', 'Insert', { control: true })
    const shiftInsert = chord('Insert', 'Insert', { shift: true })
    const bareInsert = chord('Insert', 'Insert')

    for (const platform of ['linux', 'win32'] as const) {
      expect(isChordReservedForTextEntry(ctrlInsert, SINGLE_LINE, platform)).toBe(true)
      expect(isChordReservedForTextEntry(shiftInsert, SINGLE_LINE, platform)).toBe(true)
      // Nothing binds Insert alone in a text field, so it stays available to the app.
      expect(isChordReservedForTextEntry(bareInsert, SINGLE_LINE, platform)).toBe(false)
    }
    // macOS binds no Insert key at all.
    expect(isChordReservedForTextEntry(shiftInsert, RICH_TEXT, 'darwin')).toBe(false)
  })

  it('leaves an Insert chord nobody binds to the app', () => {
    for (const extra of [{ shift: true }, { alt: true }, { meta: true }]) {
      const overloaded = chord('Insert', 'Insert', { control: true, ...extra })

      expect(isChordReservedForTextEntry(overloaded, SINGLE_LINE, 'win32')).toBe(false)
    }
  })

  it('reserves the Option deletion gestures through their named keys', () => {
    // AppKit's ~<backspace> and ~<delete> are word deletes; they need no letter rule
    // because Backspace and Delete are reserved under any modifier.
    for (const named of ['Backspace', 'Delete']) {
      expect(
        isChordReservedForTextEntry(chord(named, named, { alt: true }), SINGLE_LINE, 'darwin')
      ).toBe(true)
    }
  })

  it('ignores a synthetic input that carries no key', () => {
    expect(isChordReservedForTextEntry({ doubleTapModifier: 'Cmd' }, RICH_TEXT, 'darwin')).toBe(
      false
    )
  })
})
