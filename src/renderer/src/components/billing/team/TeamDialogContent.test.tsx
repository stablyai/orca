// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Dialog } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TeamDialogContent } from './TeamDialogHost'

afterEach(cleanup)

// TEAM-MODAL-CENTER: the Team dialog (opened from the account menu, Create a team, or after
// Checkout; all go through this one surface) is centred in the window like every other dialog.
it('centres the Team dialog in the window instead of pinning it near the top', () => {
  render(
    <TooltipProvider>
      <Dialog open>
        <TeamDialogContent>
          <p>Team</p>
        </TeamDialogContent>
      </Dialog>
    </TooltipProvider>
  )
  const dialog = document.querySelector<HTMLElement>('[data-team-dialog]')!
  // Portaled to the document, not into the menu that opened it.
  expect(dialog.closest('[data-slot="dropdown-menu-content"]')).toBeNull()
  const classes = dialog.className.split(/\s+/)
  expect(classes).toContain('fixed')
  expect(classes).toContain('top-[50%]')
  expect(classes).toContain('left-[50%]')
  expect(classes).toContain('translate-y-[-50%]')
  expect(classes).toContain('translate-x-[-50%]')
  expect(classes).not.toContain('top-[6vh]')
  expect(classes).not.toContain('translate-y-0')
})
