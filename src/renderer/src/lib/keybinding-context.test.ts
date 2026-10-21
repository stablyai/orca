// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { EDITOR_KEYMAP_ATTRIBUTE, getKeybindingContext } from './keybinding-context'

describe('getKeybindingContext', () => {
  it('maps xterm input, editor-first keymap editors, and everything else', () => {
    const terminal = document.createElement('textarea')
    terminal.classList.add('xterm-helper-textarea')
    expect(getKeybindingContext(terminal)).toBe('terminal')

    const editor = document.createElement('div')
    editor.setAttribute(EDITOR_KEYMAP_ATTRIBUTE, 'emacs')
    const findInput = document.createElement('input')
    editor.append(findInput)
    expect(getKeybindingContext(editor)).toBe('editor')
    expect(getKeybindingContext(findInput)).toBe('editor')

    const plainEditor = document.createElement('div')
    plainEditor.className = 'monaco-editor'
    expect(getKeybindingContext(plainEditor)).toBe('app')
    expect(getKeybindingContext(document.body)).toBe('app')
    expect(getKeybindingContext(null)).toBe('app')
  })
})
