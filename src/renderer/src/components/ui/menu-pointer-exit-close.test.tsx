// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './dropdown-menu'
import { useMenuPointerExitClose } from './menu-pointer-exit-close'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Row(): React.JSX.Element {
  const { rowRef, triggerRef, ...menu } = useMenuPointerExitClose<
    HTMLDivElement,
    HTMLButtonElement
  >()
  return (
    <div ref={rowRef} data-row>
      <DropdownMenu open={menu.open} onOpenChange={menu.onOpenChange}>
        <DropdownMenuTrigger ref={triggerRef} {...menu.triggerProps}>
          More
        </DropdownMenuTrigger>
        <DropdownMenuContent {...menu.contentProps}>
          <DropdownMenuItem>Done</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Elsewhere</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Row 0–300 × 0–28, trigger at its right edge, menu below it, submenu far to the right.
function renderOpenRow(): () => boolean {
  render(<Row />)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [left, top, right, bottom] = this.matches('[data-row]')
      ? [0, 0, 300, 28]
      : this.matches('[data-slot="dropdown-menu-content"]')
        ? [110, 30, 290, 100]
        : this.matches('[data-slot="dropdown-menu-sub-content"]')
          ? [500, 30, 700, 100]
          : [270, 2, 290, 26]
    return {
      left,
      top,
      right,
      bottom,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({})
    }
  })
  act(() => {
    screen
      .getByRole('button', { name: 'More' })
      .dispatchEvent(
        new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
  })
  const isOpen = () => document.querySelector('[data-slot="dropdown-menu-content"]') !== null
  expect(isOpen()).toBe(true)
  return isOpen
}

it('keeps the menu open while the pointer is over its portaled submenu', () => {
  const isOpen = renderOpenRow()
  const submenu = document.querySelector('[data-slot="dropdown-menu-sub-content"]')!
  act(() => {
    submenu.dispatchEvent(
      new window.PointerEvent('pointermove', { bubbles: true, clientX: 600, clientY: 60 })
    )
  })
  expect(isOpen()).toBe(true)
})

it('closes the menu when the pointer leaves the window from inside the menu', () => {
  const isOpen = renderOpenRow()
  const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!
  act(() => {
    menu.dispatchEvent(
      new window.PointerEvent('pointerout', { bubbles: true, relatedTarget: null })
    )
  })
  expect(isOpen()).toBe(false)
})
