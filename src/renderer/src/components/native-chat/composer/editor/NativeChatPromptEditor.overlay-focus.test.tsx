// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function editor(inputRef: React.RefObject<NativeChatComposerInput | null>) {
  return (
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue="Draft"
      disabled={false}
      placeholder="Message"
      onChange={() => {}}
      onSelect={() => {}}
    />
  )
}

function setup() {
  vi.useFakeTimers()
  const inputRef = createRef<NativeChatComposerInput>()
  render(
    <>
      {editor(inputRef)}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent id="launcher-menu">
          <input
            role="combobox"
            aria-label="Search launcher"
            aria-controls="launcher-menu"
            aria-expanded="true"
          />
          <DropdownMenuItem>New Terminal</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
  act(() => inputRef.current!.focus())
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New tab' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  act(() => screen.getByRole('combobox', { name: 'Search launcher' }).focus())
  return inputRef.current!
}

describe('composer focus while the quick launcher is open', () => {
  it('keeps launcher search focused when a late composer focus call arrives', async () => {
    const input = setup()
    const search = screen.getByRole('combobox', { name: 'Search launcher' })
    expect(document.activeElement).toBe(search)

    await act(async () => {
      input.focus()
      await vi.runOnlyPendingTimersAsync()
    })

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(document.activeElement).toBe(search)
  })
})
