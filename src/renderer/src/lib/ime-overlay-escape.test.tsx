// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CommandDialog, CommandInput } from '@/components/ui/command'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { handleImeOverlayEscape } from './ime-overlay-escape'

afterEach(cleanup)

type OverlayProps = {
  children: ReactNode
  onOpenChange: (open: boolean) => void
  onEscapeKeyDown: (event: KeyboardEvent) => void
}
const overlays = {
  Dialog: ({ children, onOpenChange, onEscapeKeyDown }: OverlayProps) => (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} onEscapeKeyDown={onEscapeKeyDown}>
        <DialogTitle>Rename</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  ),
  Sheet: ({ children, onOpenChange, onEscapeKeyDown }: OverlayProps) => (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} onEscapeKeyDown={onEscapeKeyDown}>
        <SheetTitle>Rename</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  ),
  Popover: ({ children, onOpenChange, onEscapeKeyDown }: OverlayProps) => (
    <Popover open onOpenChange={onOpenChange}>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent onEscapeKeyDown={onEscapeKeyDown}>{children}</PopoverContent>
    </Popover>
  ),
  DropdownMenu: ({ children, onOpenChange, onEscapeKeyDown }: OverlayProps) => (
    <DropdownMenu open onOpenChange={onOpenChange}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent onEscapeKeyDown={onEscapeKeyDown}>{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

describe.each(Object.entries(overlays))('%s IME Escape', (_name, Overlay) => {
  it.each([{ isComposing: true, keyCode: 27 }, { keyCode: 229 }])(
    'keeps the overlay open while cancelling a candidate: %j',
    (marker) => {
      const changed = vi.fn(),
        escape = vi.fn()
      const { getByRole } = render(
        <Overlay onOpenChange={changed} onEscapeKeyDown={escape}>
          <Input />
        </Overlay>
      )
      const field = getByRole('textbox')
      fireEvent.compositionStart(field)
      fireEvent.keyDown(field, { key: 'Escape', ...marker })
      expect(changed).not.toHaveBeenCalled()
      expect(escape).not.toHaveBeenCalled()
      fireEvent.compositionEnd(field)
      fireEvent.keyDown(field, { key: 'Escape', keyCode: 27 })
      expect(escape).toHaveBeenCalledOnce()
      expect(changed).toHaveBeenCalledExactlyOnceWith(false)
    }
  )
})

it('keeps command dialogs open on IME Escape and dismisses on ordinary Escape', () => {
  const changed = vi.fn()
  const { getByRole } = render(
    <CommandDialog open onOpenChange={changed}>
      <CommandInput />
    </CommandDialog>
  )
  fireEvent.keyDown(getByRole('combobox'), { key: 'Escape', keyCode: 229 })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.keyDown(getByRole('combobox'), { key: 'Escape', keyCode: 27 })
  expect(changed).toHaveBeenCalledExactlyOnceWith(false)
})

it('preserves caller cancellation of ordinary Escape', () => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  const escape = vi.fn((event: KeyboardEvent) => event.preventDefault())
  handleImeOverlayEscape(event, escape)
  expect(escape).toHaveBeenCalledExactlyOnceWith(event)
  expect(event.defaultPrevented).toBe(true)
})

it('keeps a context menu field open on IME Escape', () => {
  const changed = vi.fn(),
    escape = vi.fn()
  const { getByRole, getByText } = render(
    <ContextMenu onOpenChange={changed}>
      <ContextMenuTrigger>Open menu</ContextMenuTrigger>
      <ContextMenuContent onEscapeKeyDown={escape}>
        <Input />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(getByText('Open menu'))
  changed.mockClear()
  fireEvent.keyDown(getByRole('textbox'), { key: 'Escape', keyCode: 229 })
  expect(changed).not.toHaveBeenCalled()
  expect(escape).not.toHaveBeenCalled()
  fireEvent.keyDown(getByRole('textbox'), { key: 'Escape', keyCode: 27 })
  expect(escape).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledExactlyOnceWith(false)
})
