// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useMemo, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeLineageToggle } from './WorktreeLineageToggle'
import { createLineageToggleHandlerCache } from './worktree-lineage-toggle-handler-cache'

vi.mock('../activity/use-worktree-activity-statuses', () => ({
  useWorktreeActivityStatuses: () => new Map()
}))

afterEach(cleanup)

it('dismisses the disclosure tooltip on keyboard activation without selecting the card or losing focus', async () => {
  const activateCard = vi.fn()
  function Card() {
    const [collapsed, setCollapsed] = useState(false)
    const toggle = useMemo(
      () => createLineageToggleHandlerCache(() => setCollapsed((value) => !value))('parent'),
      []
    )
    return (
      <TooltipProvider>
        <div onClick={activateCard}>
          <WorktreeLineageToggle
            collapsed={collapsed}
            ariaLabel="Toggle child workspaces"
            label="Children"
            count={1}
            onToggle={toggle}
          />
          {!collapsed && <span>Child workspace</span>}
        </div>
      </TooltipProvider>
    )
  }
  const user = userEvent.setup()
  render(<Card />)
  const toggle = screen.getByRole('button', { name: 'Toggle child workspaces' })

  await user.tab()
  expect(await screen.findByRole('tooltip')).toBeInTheDocument()
  await user.keyboard('{Enter}')

  expect(screen.queryByText('Child workspace')).not.toBeInTheDocument()
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  expect(toggle).toHaveFocus()
  expect(activateCard).not.toHaveBeenCalled()
})
