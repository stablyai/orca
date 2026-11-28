// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PermissionChoiceRadioItem } from './PermissionChoiceRadioItem'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderMenu(onSelect = vi.fn(), disabled = false) {
  render(
    <TooltipProvider>
      <DropdownMenu>
        <DropdownMenuTrigger>Permissions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="">
            <PermissionChoiceRadioItem
              value="auto"
              description="Reviews approval requests for you"
              disabled={disabled}
              onSelect={onSelect}
            >
              Approve for me
            </PermissionChoiceRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  fireEvent.keyDown(screen.getByRole('button', { name: 'Permissions' }), { key: 'ArrowDown' })
  return onSelect
}

it('keeps a disabled row focusable but never selects it', async () => {
  const onSelect = renderMenu(vi.fn(), true)
  const item = await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  expect(item.hasAttribute('data-disabled')).toBe(false)
  fireEvent.keyDown(item, { key: 'Enter' })
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeNull()
})

it('closes the menu with one Escape while the tooltip is open', async () => {
  renderMenu()
  const item = await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  item.focus()
  await screen.findByRole('tooltip')
  fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
})
