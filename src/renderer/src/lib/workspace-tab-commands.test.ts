// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isTerminalClosePromptFocused } from './workspace-tab-commands'

describe('isTerminalClosePromptFocused', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is false with nothing focused', () => {
    expect(isTerminalClosePromptFocused()).toBe(false)
  })

  it('is true when focus sits inside the terminal close prompt', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('data-close-terminal-dialog', 'true')
    const button = document.createElement('button')
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    button.focus()

    expect(isTerminalClosePromptFocused()).toBe(true)
  })

  it('is false for focus in an unrelated surface', () => {
    const other = document.createElement('div')
    const button = document.createElement('button')
    other.appendChild(button)
    document.body.appendChild(other)
    button.focus()

    expect(isTerminalClosePromptFocused()).toBe(false)
  })
})
