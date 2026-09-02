// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomAddressDialog } from './CustomAddressDialog'

afterEach(cleanup)

const copy = {
  title: 'Custom network address',
  description: 'Choose an address.',
  inputLabel: 'Address',
  placeholder: 'host.example',
  hint: 'Enter a reachable address.',
  cancel: 'Cancel',
  confirm: 'Use address',
  confirmationError: 'This address could not produce a scannable pairing code.'
}

describe('CustomAddressDialog', () => {
  it('keeps a failed asynchronous confirmation open and does not commit it', async () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn().mockResolvedValue(false)

    render(
      <CustomAddressDialog
        open
        onOpenChange={onOpenChange}
        validate={(input) => (input ? { ok: true, value: input } : { ok: false })}
        copy={copy}
        inputId="custom-address"
        onConfirm={onConfirm}
      />
    )

    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'large.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use address' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('large.example'))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('could not produce')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
