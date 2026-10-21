// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import { keepFocusWhileMenuCloses } from './menu-item-closing-focus'

function pointerEventOnItem(menuState: 'open' | 'closed'): React.PointerEvent<HTMLDivElement> {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('data-state', menuState)
  const item = menu.appendChild(document.createElement('div'))
  const event = { currentTarget: item, preventDefault: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only currentTarget and preventDefault.
  return event as unknown as React.PointerEvent<HTMLDivElement>
}

describe('keepFocusWhileMenuCloses', () => {
  // A New Chat chosen from the menu lost every key after the first: the closing menu took focus back.
  it('cancels the library pointer focus only while the menu is closing, after the caller runs', () => {
    const caller = vi.fn()
    const closing = pointerEventOnItem('closed')
    keepFocusWhileMenuCloses(caller)(closing)
    expect(caller).toHaveBeenCalledWith(closing)
    expect(closing.preventDefault).toHaveBeenCalled()

    const open = pointerEventOnItem('open')
    keepFocusWhileMenuCloses(undefined)(open)
    expect(open.preventDefault).not.toHaveBeenCalled()
  })
})
