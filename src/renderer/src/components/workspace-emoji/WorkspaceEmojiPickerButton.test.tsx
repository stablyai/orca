// @vitest-environment happy-dom

import { createRef, useRef, useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as I18nModule from '@/i18n/i18n'
import { translate } from '@/i18n/i18n'
import { WorkspaceEmojiPickerButton } from './WorkspaceEmojiPickerButton'

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return { ...actual, translate: vi.fn(actual.translate) }
})

// The button reads its aria-label once per render, so this counts its renders.
function buttonRenderCount(): number {
  return vi.mocked(translate).mock.calls.filter(([key]) => key === 'workspace.links.addEmoji')
    .length
}

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

it('does not re-render while the user types in the name field', async () => {
  const user = userEvent.setup()
  function Field(): React.JSX.Element {
    const [value, setValue] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)
    return (
      <>
        <input
          ref={inputRef}
          aria-label="Name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <WorkspaceEmojiPickerButton inputRef={inputRef} onValueChange={setValue} />
      </>
    )
  }
  render(
    <TooltipProvider>
      <Field />
    </TooltipProvider>
  )
  const rendersAfterMount = buttonRenderCount()
  expect(rendersAfterMount).toBeGreaterThan(0)

  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'release')

  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'release')
  expect(buttonRenderCount()).toBe(rendersAfterMount)
})
