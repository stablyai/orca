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

  it('redirects a chat-owned pane to its composer instead of the hidden xterm', () => {
    const pane = document.createElement('div')
    pane.className = 'pane'
    const owner = document.createElement('div')
    owner.setAttribute('data-pane-prevent-terminal-focus', 'true')
    owner.tabIndex = -1
    const composer = document.createElement('textarea')
    composer.setAttribute('data-native-chat-composer-input', 'true')
    owner.appendChild(composer)
    pane.appendChild(owner)
    const terminal = addTerminal('chat-owned')
    pane.appendChild(terminal)
    document.body.appendChild(pane)

    expect(resolvePaletteFocusRestoreTarget(null)).toBe(composer)
  })

  it('redirects a captured xterm helper whose pane switched to chat mode', () => {
    const pane = document.createElement('div')
    pane.className = 'pane'
    const terminal = addTerminal('was-terminal')
    pane.appendChild(terminal)
    const owner = document.createElement('div')
    owner.setAttribute('data-pane-prevent-terminal-focus', 'true')
    owner.tabIndex = -1
    const composer = document.createElement('textarea')
    composer.setAttribute('data-native-chat-composer-input', 'true')
    owner.appendChild(composer)
    pane.appendChild(owner)
    document.body.appendChild(pane)

    expect(resolvePaletteFocusRestoreTarget(terminal)).toBe(composer)
  })

  it('skips a hidden pane so the visible plain terminal is chosen', () => {
    const hiddenPane = document.createElement('div')
    hiddenPane.className = 'pane'
    hiddenPane.style.display = 'none'
    hiddenPane.appendChild(addTerminal('hidden'))
    document.body.appendChild(hiddenPane)
    const visiblePane = document.createElement('div')
    visiblePane.className = 'pane'
    const visibleTerminal = addTerminal('visible')
    visiblePane.appendChild(visibleTerminal)
    document.body.appendChild(visiblePane)

    expect(resolvePaletteFocusRestoreTarget(null)).toBe(visibleTerminal)
  })
})
