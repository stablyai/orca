// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { isKeyboardOrVirtualFocus, stopFocusModalityTracking } from './keyboard-input-modality'

it('stops following input once tracking is stopped', () => {
  const button = document.body.appendChild(document.createElement('button'))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
  expect(isKeyboardOrVirtualFocus()).toBe(true)

  stopFocusModalityTracking()
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  button.focus()
  expect(isKeyboardOrVirtualFocus()).toBe(true)
})
