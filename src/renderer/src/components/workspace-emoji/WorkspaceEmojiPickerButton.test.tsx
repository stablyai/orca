// @vitest-environment happy-dom

import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceEmojiPickerButton } from './WorkspaceEmojiPickerButton'

afterEach(cleanup)

it('opens with Enter inside a source command and keeps picker navigation isolated', async () => {
  const user = userEvent.setup()
  const onSourceSelect = vi.fn()
  const onSourceKeyDown = vi.fn()
  const onValueChange = vi.fn()
  const inputRef = createRef<HTMLInputElement>()
  render(
    <TooltipProvider>
      <Command onKeyDown={onSourceKeyDown}>
        <input ref={inputRef} defaultValue="Launch " />
        <WorkspaceEmojiPickerButton inputRef={inputRef} onValueChange={onValueChange} />
        <CommandList>
          <CommandItem value="source" onSelect={onSourceSelect}>
            Source result
          </CommandItem>
        </CommandList>
      </Command>
    </TooltipProvider>
  )

  await user.tab()
  inputRef.current?.setSelectionRange(7, 7)
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add emoji' }))
  onSourceKeyDown.mockClear()
  await user.keyboard('{Enter}')

  const search = await screen.findByPlaceholderText('Search emoji')
  await user.type(search, 'tada')
  await user.keyboard('{ArrowDown}{Enter}')

  expect(onValueChange).toHaveBeenCalledWith('Launch 🎉 ')
  expect(screen.queryByPlaceholderText('Search emoji')).toBeNull()
  expect(onSourceSelect).not.toHaveBeenCalled()
  expect(onSourceKeyDown).not.toHaveBeenCalled()
})
