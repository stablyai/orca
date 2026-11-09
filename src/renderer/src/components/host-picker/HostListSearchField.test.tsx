// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'

import { HostListSearchField } from './HostListSearchField'

afterEach(() => {
  cleanup()
})

describe('HostListSearchField in a menu', () => {
  it('is reached and left with arrow keys, and keeps letters out of the menu', () => {
    const onChange = vi.fn()
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>All hosts</DropdownMenuItem>
          <HostListSearchField value="" onChange={onChange} inMenu />
          <DropdownMenuCheckboxItem checked={false}>node-1</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const search = screen.getByRole('textbox', { name: 'Search hosts…' })
    const searchItem = search.closest('[role="menuitem"]')
    expect(searchItem).toBeTruthy()
    fireEvent.focus(searchItem!)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'n' })
    fireEvent.change(search, { target: { value: 'n' } })
    expect(onChange).toHaveBeenCalledWith('n')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('node-1')
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(document.activeElement?.textContent).toBe('All hosts')
  })
})
