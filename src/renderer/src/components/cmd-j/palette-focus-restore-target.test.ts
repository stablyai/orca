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
    // DOM order may put a retained background terminal before the one the user was typing in.
    addTerminal('background')
    const active = addTerminal('active')

    expect(resolvePaletteFocusRestoreTarget(active)).toBe(active)
  })
})
