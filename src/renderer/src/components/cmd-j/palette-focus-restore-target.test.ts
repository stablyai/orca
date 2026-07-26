// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePaletteFocusRestoreTarget } from './palette-focus-restore-target'

afterEach(() => {
  document.body.innerHTML = ''
})

function addTerminal(id: string): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  textarea.dataset.terminal = id
  document.body.appendChild(textarea)
  return textarea
}

describe('resolvePaletteFocusRestoreTarget', () => {
  it('returns the exact previously-focused element when it is still connected', () => {
    // Two terminals mounted (e.g. a background worktree comes first in the DOM);
    // the user was typing in the second one before opening Cmd+J.
    addTerminal('background')
    const active = addTerminal('active')

    expect(resolvePaletteFocusRestoreTarget(active)).toBe(active)
  })

  it('falls back to the first terminal when the previous element is gone', () => {
    const first = addTerminal('first')
    const detached = document.createElement('textarea')
    detached.className = 'xterm-helper-textarea'
    // Never appended → not connected (e.g. its pane unmounted while Cmd+J was open).

    expect(detached.isConnected).toBe(false)
    expect(resolvePaletteFocusRestoreTarget(detached)).toBe(first)
  })

  it('falls back to the editor textarea when no preferred target and no terminal exist', () => {
    const editor = document.createElement('div')
    editor.className = 'monaco-editor'
    const textarea = document.createElement('textarea')
    editor.appendChild(textarea)
    document.body.appendChild(editor)

    expect(resolvePaletteFocusRestoreTarget(null)).toBe(textarea)
  })

  it('prefers the terminal over the editor when both are present and nothing was captured', () => {
    const terminal = addTerminal('only')
    const editor = document.createElement('div')
    editor.className = 'monaco-editor'
    editor.appendChild(document.createElement('textarea'))
    document.body.appendChild(editor)

    expect(resolvePaletteFocusRestoreTarget(null)).toBe(terminal)
  })

  it('returns null when nothing is focusable', () => {
    expect(resolvePaletteFocusRestoreTarget(null)).toBeNull()
  })
})
