// Editor focus context: an Emacs-preset editor owns its Ctrl/Alt chords, Orca keeps the rest.
import { describe, expect, it } from 'vitest'
import {
  EMACS_EDITOR_CHORDS,
  isEmacsEditorChordBinding,
  isEmacsEditorChordInput,
  keybindingMatchesAction,
  keybindingYieldsToEmacsEditor,
  matchKeybindingDigitIndex
} from './keybindings'

const ctrl = (key: string, code: string) => ({
  key,
  code,
  control: true,
  meta: false,
  alt: false,
  shift: false
})

describe('editor keybinding context', () => {
  it.each(['linux', 'win32'] as const)(
    'yields Emacs chords to a focused editor on %s while app focus keeps them',
    (platform) => {
      const chords = [
        { action: 'worktree.quickOpen', key: 'p', code: 'KeyP' },
        { action: 'workspace.create', key: 'n', code: 'KeyN' },
        { action: 'voice.dictation', key: 'e', code: 'KeyE' },
        { action: 'sidebar.left.toggle', key: 'b', code: 'KeyB' },
        { action: 'sidebar.right.toggle', key: 'l', code: 'KeyL' },
        { action: 'tab.newTerminal', key: 't', code: 'KeyT' },
        { action: 'tab.close', key: 'w', code: 'KeyW' },
        { action: 'editor.save', key: 's', code: 'KeyS' },
        { action: 'editor.find', key: 'f', code: 'KeyF' }
      ] as const
      for (const chord of chords) {
        const input = ctrl(chord.key, chord.code)
        expect(keybindingMatchesAction(chord.action, input, platform)).toBe(true)
        expect(
          keybindingMatchesAction(chord.action, input, platform, undefined, { context: 'editor' })
        ).toBe(false)
        expect(
          keybindingMatchesAction(chord.action, input, platform, undefined, { context: 'app' })
        ).toBe(true)
      }
    }
  )

  it('keeps chords the preset does not bind, even inside the editor', () => {
    const shiftP = { key: 'P', code: 'KeyP', control: true, meta: false, alt: false, shift: true }
    expect(keybindingMatchesAction('app.forceReload', ctrl('r', 'KeyR'), 'linux')).toBe(false)
    expect(
      keybindingMatchesAction(
        'sidebar.explorer.toggle',
        { ...shiftP, key: 'E', code: 'KeyE' },
        'linux',
        undefined,
        { context: 'editor' }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction('tab.previousRecent', ctrl('Tab', 'Tab'), 'linux', undefined, {
        context: 'editor'
      })
    ).toBe(true)
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        ctrl('1', 'Digit1'),
        'linux',
        undefined,
        {
          context: 'editor'
        }
      )
    ).toBe(0)
  })

  it('does not touch macOS Cmd shortcuts, but still yields physical Control chords there', () => {
    const cmdP = { key: 'p', code: 'KeyP', control: false, meta: true, alt: false, shift: false }
    expect(
      keybindingMatchesAction('worktree.quickOpen', cmdP, 'darwin', undefined, {
        context: 'editor'
      })
    ).toBe(true)
    expect(isEmacsEditorChordInput(cmdP, 'darwin')).toBe(false)
    expect(isEmacsEditorChordInput(ctrl('p', 'KeyP'), 'darwin')).toBe(true)
    expect(
      keybindingMatchesAction(
        'worktree.quickOpen',
        ctrl('p', 'KeyP'),
        'darwin',
        { 'worktree.quickOpen': ['Ctrl+P'] },
        { context: 'editor' }
      )
    ).toBe(false)
  })

  it('recognises Meta chords by physical key so macOS Option composition cannot hide them', () => {
    const optionF = { key: 'ƒ', code: 'KeyF', control: false, meta: false, alt: true, shift: false }
    expect(isEmacsEditorChordInput(optionF, 'darwin')).toBe(true)
    const altZ = { key: 'z', code: 'KeyZ', control: false, meta: false, alt: true, shift: false }
    expect(isEmacsEditorChordInput(altZ, 'linux')).toBe(false)
    expect(
      keybindingMatchesAction('editor.toggleWordWrap', altZ, 'linux', undefined, {
        context: 'editor'
      })
    ).toBe(true)
  })

  it('never claims a terminal or app context chord', () => {
    for (const context of ['app', 'terminal', 'browser'] as const) {
      expect(
        keybindingMatchesAction('worktree.quickOpen', ctrl('p', 'KeyP'), 'linux', undefined, {
          context,
          terminalShortcutPolicy: 'orca-first'
        })
      ).toBe(true)
    }
  })

  it('reports which Settings rows are inactive while an Emacs editor has focus', () => {
    expect(EMACS_EDITOR_CHORDS.every((chord) => isEmacsEditorChordBinding(chord, 'linux'))).toBe(
      true
    )
    expect(isEmacsEditorChordBinding('Mod+P', 'linux')).toBe(true)
    expect(isEmacsEditorChordBinding('Mod+P', 'darwin')).toBe(false)
    expect(isEmacsEditorChordBinding('Mod+Shift+P', 'linux')).toBe(false)
    expect(isEmacsEditorChordBinding('DoubleTap+Shift', 'linux')).toBe(false)
    expect(keybindingYieldsToEmacsEditor('worktree.quickOpen', 'linux')).toBe(true)
    expect(keybindingYieldsToEmacsEditor('worktree.quickOpen', 'darwin')).toBe(false)
    expect(keybindingYieldsToEmacsEditor('worktree.palette', 'linux')).toBe(false)
    expect(
      keybindingYieldsToEmacsEditor('worktree.palette', 'linux', { 'worktree.palette': ['Alt+F'] })
    ).toBe(true)
  })
})
