// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from './dialog'
import { DialogCancel, DialogDisclosure } from './dialog-parts'

const noop = (): void => {}

function UnifiedDialog({
  busy = false,
  initialFocus,
  onOpenChange = noop
}: {
  busy?: boolean
  initialFocus?: 'cancel'
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        size="confirm"
        busy={busy}
        initialFocus={initialFocus}
        aria-describedby={undefined}
      >
        <DialogTitle>Delete fix-login?</DialogTitle>
        <DialogDisclosure label="Show changes">M src/login.ts</DialogDisclosure>
        <DialogFooter start={<Button size="sm">Sleep instead</Button>}>
          <DialogCancel>Cancel</DialogCancel>
          <Button size="sm" variant="destructive">
            Delete workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

describe('unified dialog layout', () => {
  afterEach(cleanup)

  it('starts focus on Cancel when asked, ahead of earlier controls', async () => {
    render(<UnifiedDialog initialFocus="cancel" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
  })

  it('blocks Esc and Cancel while busy, and closes on Esc otherwise', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<UnifiedDialog busy onOpenChange={onOpenChange} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()

    rerender(<UnifiedDialog onOpenChange={onOpenChange} />)
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reports the disclosure state on the button that controls it', async () => {
    render(<UnifiedDialog />)
    const toggle = screen.getByRole('button', { name: 'Show changes' })
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(region).not.toBeVisible()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(region).toBeVisible()
    expect(region).toHaveTextContent('M src/login.ts')
  })
})
