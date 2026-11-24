// @vitest-environment happy-dom
// A chat row's menu opened from the keyboard sits just under the row, so the row stays in view.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KEYBOARD_MENU_GAP_PX, openRowMenuFromKeyboard } from './BotChatEndMenu'

afterEach(cleanup)

function row(onMenu: (event: MouseEvent) => void): HTMLElement {
  render(
    <button type="button" onKeyDown={(event) => openRowMenuFromKeyboard(event)}>
      Water the lawn
    </button>
  )
  const element = screen.getByRole('button', { name: 'Water the lawn' })
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 30, y: 350, width: 240, height: 28 })
  )
  element.addEventListener('contextmenu', onMenu)
  return element
}

describe('opening a chat row menu from the keyboard', () => {
  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['the Menu key', { key: 'ContextMenu' }]
  ])('anchors %s at the row lower left, just below it', (_name, keys) => {
    const opened = vi.fn((event: MouseEvent) => [event.clientX, event.clientY])
    fireEvent.keyDown(row(opened), keys)

    expect(opened).toHaveReturnedWith([30, 350 + 28 + KEYBOARD_MENU_GAP_PX])
  })

  it('leaves other keys to the row', () => {
    const opened = vi.fn()
    fireEvent.keyDown(row(opened), { key: 'F10' })

    expect(opened).not.toHaveBeenCalled()
  })
})
