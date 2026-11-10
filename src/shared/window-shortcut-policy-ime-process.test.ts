import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction, type WindowShortcutInput } from './window-shortcut-policy'
import { keybindingFromInput } from './keybindings'

// A chord pressed while an IME has marked text arrives as key 'Process' (keyCode 229); only `code` names the key.
function imeChord(code: string, modifiers: Partial<WindowShortcutInput>): WindowShortcutInput {
  return {
    type: 'keyDown',
    code,
    key: 'Process',
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...modifiers
  }
}

describe('window shortcuts pressed during IME composition (#28159)', () => {
  it('switches tabs with Ctrl+digit on macOS while a Hangul syllable is composing', () => {
    expect(resolveWindowShortcutAction(imeChord('Digit2', { control: true }), 'darwin')).toEqual({
      type: 'jumpToTabIndex',
      index: 1
    })
  })

  it('switches workspaces with Cmd+digit on macOS while composing', () => {
    expect(resolveWindowShortcutAction(imeChord('Digit3', { meta: true }), 'darwin')).toEqual({
      type: 'jumpToWorktreeIndex',
      index: 2
    })
  })

  it('uses the platform chords on Windows and Linux while composing', () => {
    expect(resolveWindowShortcutAction(imeChord('Digit4', { alt: true }), 'win32')).toEqual({
      type: 'jumpToTabIndex',
      index: 3
    })
    expect(resolveWindowShortcutAction(imeChord('Digit4', { control: true }), 'linux')).toEqual({
      type: 'jumpToWorktreeIndex',
      index: 3
    })
  })

  it('leaves unmodified and Shift-only IME keys with the composer', () => {
    expect(resolveWindowShortcutAction(imeChord('Digit2', {}), 'darwin')).toBeNull()
    expect(resolveWindowShortcutAction(imeChord('Digit2', { shift: true }), 'darwin')).toBeNull()
  })

  it('treats Ctrl+Alt during composition as AltGr text on Windows and Linux', () => {
    expect(
      resolveWindowShortcutAction(imeChord('Digit2', { control: true, alt: true }), 'win32')
    ).toBeNull()
  })

  it('records the physical chord when a shortcut is captured during composition', () => {
    expect(keybindingFromInput(imeChord('Digit2', { control: true }), 'darwin')).toEqual({
      ok: true,
      value: 'Ctrl+2'
    })
  })
})
