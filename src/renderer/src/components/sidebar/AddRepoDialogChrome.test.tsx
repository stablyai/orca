// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { AddRepoDialogChrome } from './AddRepoDialogChrome'

afterEach(cleanup)

function CloneDialog({
  isCloning,
  onOpenChange
}: {
  isCloning: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [isOpen, setIsOpen] = useState(true)
  return (
    <AddRepoDialogChrome
      isCloning={isCloning}
      isAdding={false}
      isOpen={isOpen}
      step="clone"
      onBack={() => {}}
      onOpenChange={(open) => {
        onOpenChange(open)
        setIsOpen(open)
      }}
    >
      <DialogTitle>Clone from URL</DialogTitle>
      <DialogDescription>Clone progress</DialogDescription>
    </AddRepoDialogChrome>
  )
}

function backdrop(): Element {
  const overlay = document.querySelector('[data-slot="dialog-overlay"]')
  if (!overlay) {
    throw new Error('Missing dialog backdrop')
  }
  return overlay
}

describe('AddRepoDialogChrome dismissal', () => {
  it('keeps an in-flight clone open after a backdrop click', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<CloneDialog isCloning onOpenChange={onOpenChange} />)

    await user.click(backdrop())

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Clone from URL' })).not.toBeNull()
  })

  it('allows backdrop dismissal when no clone is running', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<CloneDialog isCloning={false} onOpenChange={onOpenChange} />)

    await user.click(backdrop())

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog', { name: 'Clone from URL' })).toBeNull()
  })

  it('allows backdrop dismissal after the clone settles', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const view = render(<CloneDialog isCloning onOpenChange={onOpenChange} />)
    await user.click(backdrop())
    expect(onOpenChange).not.toHaveBeenCalled()

    view.rerender(<CloneDialog isCloning={false} onOpenChange={onOpenChange} />)
    await user.click(backdrop())

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog', { name: 'Clone from URL' })).toBeNull()
  })

  it.each(['Escape', 'Close'])(
    'keeps explicit %s dismissal available during a clone',
    async (action) => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      render(<CloneDialog isCloning onOpenChange={onOpenChange} />)

      await (action === 'Escape'
        ? user.keyboard('{Escape}')
        : user.click(screen.getByRole('button', { name: 'Close' })))

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(screen.queryByRole('dialog', { name: 'Clone from URL' })).toBeNull()
    }
  )
})
