// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '../../ui/tooltip'
import { AgentChoiceMenu } from './AgentChoiceMenu'

afterEach(cleanup)

const choices = [
  { value: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', legacy: true }
]

it.each([false, true])(
  'reopens with the selected legacy model shown after a collapse (row=%s)',
  async (row) => {
    render(
      <TooltipProvider>
        <AgentChoiceMenu
          label="Model"
          value="gpt-5.6-terra"
          choices={choices}
          row={row}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
    const open = () =>
      fireEvent.keyDown(
        row
          ? screen.getByRole('button', { name: 'Model: GPT 5.6 Terra', hidden: true })
          : screen.getByRole('combobox', { hidden: true }),
        { key: 'ArrowDown' }
      )
    const itemRole = row ? 'menuitemradio' : 'option'
    open()
    await screen.findByRole(itemRole, { name: 'GPT 5.6 Terra' })
    fireEvent.click(screen.getByRole(row ? 'menuitem' : 'option', { name: 'Legacy models (1)' }))
    expect(screen.queryByRole(itemRole, { name: 'GPT 5.6 Terra' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole(row ? 'menu' : 'listbox')).toBeNull())
    open()
    expect(await screen.findByRole(itemRole, { name: 'GPT 5.6 Terra' })).not.toBeNull()
  }
)
