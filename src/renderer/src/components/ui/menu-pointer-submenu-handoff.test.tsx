// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import * as Dropdown from './dropdown-menu'
import * as Context from './context-menu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['dropdown', 'context'] as const)(
  'leaves prevented %s submenu hover to Radix and opens with the keyboard without clicking',
  (kind) => {
    const Menu = kind === 'dropdown' ? Dropdown.DropdownMenu : Context.ContextMenu
    const Trigger = kind === 'dropdown' ? Dropdown.DropdownMenuTrigger : Context.ContextMenuTrigger
    const Content = kind === 'dropdown' ? Dropdown.DropdownMenuContent : Context.ContextMenuContent
    const Sub = kind === 'dropdown' ? Dropdown.DropdownMenuSub : Context.ContextMenuSub
    const SubTrigger =
      kind === 'dropdown' ? Dropdown.DropdownMenuSubTrigger : Context.ContextMenuSubTrigger
    const SubContent =
      kind === 'dropdown' ? Dropdown.DropdownMenuSubContent : Context.ContextMenuSubContent
    const Item = kind === 'dropdown' ? Dropdown.DropdownMenuItem : Context.ContextMenuItem
    const selected = vi.fn()
    const clicked = vi.fn()
    render(
      <Menu modal={false}>
        <Trigger>Open</Trigger>
        <Content onClick={clicked}>
          <Sub>
            <SubTrigger>First</SubTrigger>
            <SubContent>
              <Item>First child</Item>
            </SubContent>
          </Sub>
          <Sub>
            <SubTrigger>Second</SubTrigger>
            <SubContent>
              <Item onSelect={selected}>Second child</Item>
            </SubContent>
          </Sub>
        </Content>
      </Menu>
    )
    if (kind === 'dropdown') {
      fireEvent.pointerDown(screen.getByText('Open'), {
        button: 0,
        pointerType: 'mouse',
        ctrlKey: false
      })
    } else {
      fireEvent.contextMenu(screen.getByText('Open'), { clientX: 40, clientY: 20 })
    }
    const first = screen.getByRole('menuitem', { name: 'First' })
    const second = screen.getByRole('menuitem', { name: 'Second' })
    fireEvent.click(first)
    expect(screen.getByRole('menuitem', { name: 'First child' })).toBeTruthy()
    clicked.mockClear()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(second)
    // Emulate a move swallowed by Radix's safe triangle at the content boundary.
    second.addEventListener('pointermove', (event) => event.preventDefault())
    vi.useFakeTimers()
    fireEvent.pointerMove(second, { pointerType: 'mouse', clientX: 10, clientY: 40 })
    act(() => vi.advanceTimersByTime(1_000))
    expect(first.getAttribute('data-state')).toBe('open')
    expect(second.getAttribute('data-state')).toBe('closed')
    expect(clicked).not.toHaveBeenCalled()

    fireEvent.keyDown(first, { key: 'ArrowDown' })
    act(() => vi.runOnlyPendingTimers())
    expect(second).toBe(document.activeElement)
    fireEvent.keyDown(second, { key: 'ArrowRight' })
    expect(second.getAttribute('data-state')).toBe('open')
    expect(first.getAttribute('data-state')).toBe('closed')
    expect(screen.getByRole('menuitem', { name: 'Second child' })).toBeTruthy()
    expect(selected).not.toHaveBeenCalled()
    expect(clicked).not.toHaveBeenCalled()
  }
)
