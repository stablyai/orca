// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddressPicker } from './AddressPicker'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const LAN_OPTION = { value: '192.168.1.24', label: '192.168.1.24 (en0)' }
const CUSTOM_VALUE = 'orca.example.com'

function pickerProps(
  overrides: Partial<ComponentProps<typeof AddressPicker>> = {}
): ComponentProps<typeof AddressPicker> {
  return {
    options: [LAN_OPTION],
    value: LAN_OPTION.value,
    onValueChange: vi.fn(),
    formatCustomLabel: (value) => `${value} (custom)`,
    addCustomLabel: 'Add custom address…',
    customDialogCopy: {
      title: 'Custom network address',
      description: 'Use an address another device can reach.',
      inputLabel: 'Address',
      placeholder: 'orca.example.com',
      hint: 'Enter a hostname or IP address.',
      cancel: 'Cancel',
      confirm: 'Use address'
    },
    validateCustom: (input) =>
      input.trim() === '' ? { ok: false } : { ok: true, value: input.trim() },
    customInputId: 'custom-address',
    placeholder: 'No addresses found',
    triggerAriaLabel: 'Network address',
    ...overrides
  }
}

describe('AddressPicker', () => {
  it('preserves the active item when a custom address becomes discovered', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { rerender } = render(
      <AddressPicker
        {...pickerProps({ value: CUSTOM_VALUE, onValueChange, options: [LAN_OPTION] })}
      />
    )

    await user.click(screen.getByRole('combobox'))
    const customItem = screen.getByRole('option', { name: `${CUSTOM_VALUE} (custom)` })

    rerender(
      <AddressPicker
        {...pickerProps({
          value: CUSTOM_VALUE,
          onValueChange,
          options: [LAN_OPTION, { value: CUSTOM_VALUE, label: `${CUSTOM_VALUE} (tailscale0)` }]
        })}
      />
    )

    expect(screen.getByRole('option', { name: `${CUSTOM_VALUE} (tailscale0)` })).toBe(customItem)
  })

  it('renders the first label for duplicate address values', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <AddressPicker
        {...pickerProps({
          options: [
            LAN_OPTION,
            { value: LAN_OPTION.value, label: `${LAN_OPTION.value} (bridge0)` },
            { value: '100.64.1.20', label: '100.64.1.20 (tailscale0)' }
          ]
        })}
      />
    )

    await user.click(screen.getByRole('combobox'))
    const listbox = screen.getByRole('listbox')
    const renderedOptions = within(listbox).getAllByRole('option')

    expect(renderedOptions.map((option) => option.textContent)).toEqual([
      LAN_OPTION.label,
      '100.64.1.20 (tailscale0)'
    ])
    expect(within(listbox).getByRole('option', { name: LAN_OPTION.label })).toBeVisible()
    expect(within(listbox).queryByRole('option', { name: /bridge0/ })).toBeNull()
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')
  })

  it('uses stable address values for typeahead', async () => {
    const user = userEvent.setup()
    render(
      <AddressPicker
        {...pickerProps({
          options: [LAN_OPTION, { value: CUSTOM_VALUE, label: `Tailnet host (${CUSTOM_VALUE})` }]
        })}
      />
    )

    await user.click(screen.getByRole('combobox'))
    await user.keyboard('o')

    expect(screen.getByRole('option', { name: `Tailnet host (${CUSTOM_VALUE})` })).toHaveFocus()
  })

  it('keeps the custom action outside the address listbox', async () => {
    const user = userEvent.setup()
    render(<AddressPicker {...pickerProps()} />)

    const addButton = screen.getByRole('button', { name: 'Add custom address…' })
    await user.click(screen.getByRole('combobox'))

    const listbox = screen.getByRole('listbox')
    expect(within(listbox).queryByRole('button', { name: 'Add custom address…' })).toBeNull()
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    expect(addButton).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('restores focus to the custom action after every dialog close path', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<AddressPicker {...pickerProps({ onValueChange })} />)

    const addButton = screen.getByRole('button', { name: 'Add custom address…' })
    await user.click(addButton)
    expect(screen.getByLabelText('Address')).toHaveFocus()
    expect(onValueChange).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(addButton).toHaveFocus())

    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(addButton).toHaveFocus())

    await user.keyboard('{Enter}')
    await user.type(screen.getByLabelText('Address'), CUSTOM_VALUE)
    await user.click(screen.getByRole('button', { name: 'Use address' }))

    expect(onValueChange).toHaveBeenCalledWith(CUSTOM_VALUE)
    await waitFor(() => expect(addButton).toHaveFocus())
  })

  it('does not reseed an open custom dialog when options refresh', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { rerender } = render(
      <AddressPicker
        {...pickerProps({ value: CUSTOM_VALUE, onValueChange, options: [LAN_OPTION] })}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Add custom address…' }))
    const input = screen.getByLabelText('Address')
    await user.clear(input)
    await user.type(input, 'edited.example.com')

    rerender(
      <AddressPicker
        {...pickerProps({
          value: CUSTOM_VALUE,
          onValueChange,
          options: [LAN_OPTION, { value: CUSTOM_VALUE, label: `${CUSTOM_VALUE} (tailscale0)` }]
        })}
      />
    )

    expect(input).toHaveValue('edited.example.com')
  })

  it('disables both address controls', () => {
    render(<AddressPicker {...pickerProps({ disabled: true })} />)

    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add custom address…' })).toBeDisabled()
  })
})
