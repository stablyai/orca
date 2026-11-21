// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarNameDialog } from './SidebarNameDialog'

afterEach(cleanup)

describe('SidebarNameDialog', () => {
  it('does not close a reopened dialog when an earlier save resolves', async () => {
    let resolveSave!: () => void
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    const onOpenChange = vi.fn()
    const props = {
      title: 'Rename project',
      description: 'Update the project name.',
      initialName: 'First',
      confirmLabel: 'Rename',
      onOpenChange,
      onSubmit
    }

    const { rerender } = render(<SidebarNameDialog {...props} open />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Second' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))

    rerender(<SidebarNameDialog {...props} open={false} />)
    rerender(<SidebarNameDialog {...props} open initialName="Third" />)
    resolveSave()

    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalledWith(false))
  })
})
