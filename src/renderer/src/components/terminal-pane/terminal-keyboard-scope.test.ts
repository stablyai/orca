// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { keyboardEventBelongsToScope } from './terminal-keyboard-scope'

describe('terminal keyboard scope with attachment chrome', () => {
  it('keeps attachment button keyboard input out of the PTY', () => {
    const scope = document.createElement('div')
    const tray = document.createElement('div')
    tray.setAttribute('data-terminal-image-attachments', '')
    const button = document.createElement('button')
    tray.append(button)
    scope.append(tray)
    let belongs = true
    button.addEventListener('keydown', (event) => {
      belongs = keyboardEventBelongsToScope(event, scope)
    })
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(belongs).toBe(false)
  })
  it('retains ordinary terminal keyboard scope', () => {
    const scope = document.createElement('div')
    const textarea = document.createElement('textarea')
    scope.append(textarea)
    let belongs = false
    textarea.addEventListener('keydown', (event) => {
      belongs = keyboardEventBelongsToScope(event, scope)
    })
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(belongs).toBe(true)
  })
})
