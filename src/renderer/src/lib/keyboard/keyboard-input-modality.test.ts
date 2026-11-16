// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { isKeyboardOrVirtualFocus, stopFocusModalityTracking } from './keyboard-input-modality'

it('counts focus from clicking a label as pointer focus', () => {
  const input = document.body.appendChild(document.createElement('input'))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    document.body.dispatchEvent(new PointerEvent(type, { bubbles: true }))
  }
  // The browser focuses a label's control after the release events, in the same task.
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  expect(isKeyboardOrVirtualFocus()).toBe(false)
})

it('stops following input once tracking is stopped', () => {
  const button = document.body.appendChild(document.createElement('button'))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
  expect(isKeyboardOrVirtualFocus()).toBe(true)

  stopFocusModalityTracking()
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  button.focus()
  expect(isKeyboardOrVirtualFocus()).toBe(true)
})
