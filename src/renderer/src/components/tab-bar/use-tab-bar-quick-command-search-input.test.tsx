// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandInput } from '@/components/ui/command'
import { useTabBarQuickCommandSearchInput } from './use-tab-bar-quick-command-search-input'

const commands = [
  { id: 'local\0shared', label: 'Run tests' },
  { id: 'runtime:build\0shared', label: 'Build' }
]
afterEach(cleanup)

function setup() {
  const onRun = vi.fn(),
    onCommandValueChange = vi.fn()
  function Search() {
    const props = useTabBarQuickCommandSearchInput({
      commandListRef: createRef<HTMLDivElement>(),
      commandValue: commands[0].id,
      filteredCommands: commands,
      getCommandId: (item) => item.id,
      onCommandValueChange,
      onRun,
      selectedCommand: commands[0]
    })
    return (
      <Command>
        <CommandInput {...props} />
      </Command>
    )
  }
  const { getByRole } = render(<Search />)
  return { input: getByRole('combobox'), onRun, onCommandValueChange }
}

// Enter executes a terminal command, so exercise the actual guarded search field.
describe('quick command search IME ownership', () => {
  it('navigates hosted commands by the caller-provided composite key', () => {
    const { input, onCommandValueChange } = setup()
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40 })
    expect(onCommandValueChange).toHaveBeenCalledWith(commands[1].id)
  })

  it('leaves native select-all available', () => {
    const { input } = setup()
    expect(fireEvent.keyDown(input, { key: 'a', ctrlKey: true })).toBe(true)
  })

  it('does not run a command on the bare redispatch after a confirmation', () => {
    const { input, onRun } = setup()
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    expect(onRun).not.toHaveBeenCalled()
  })

  it('does not run a command during composition', () => {
    const { input, onRun } = setup()
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true })
    expect(onRun).not.toHaveBeenCalled()
  })

  it('runs a command when a modifier is held through the confirmation redispatch', () => {
    const { input, onRun } = setup()
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true, ctrlKey: true })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, ctrlKey: true })
    expect(onRun).toHaveBeenCalledExactlyOnceWith(commands[0])
  })

  it('runs a command on ordinary Enter', () => {
    const { input, onRun } = setup()
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    expect(onRun).toHaveBeenCalledExactlyOnceWith(commands[0])
  })
})
