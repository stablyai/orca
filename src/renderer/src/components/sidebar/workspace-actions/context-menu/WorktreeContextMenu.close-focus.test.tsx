// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { ConfirmationDialogProvider } from '../../../dismiss/confirmation/confirmation-dialog'
import WorktreeContextMenu from './WorktreeContextMenu'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const worktree = makeWorktree({ id: `${TEST_REPO.id}::/tmp/wt`, repoId: TEST_REPO.id })

async function openMenu() {
  useAppStore.setState({ repos: [TEST_REPO], worktreesByRepo: { [TEST_REPO.id]: [worktree] } })
  render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <div data-worktree-sidebar="" tabIndex={-1}>
          <WorktreeContextMenu worktree={worktree}>
            <div>Card</div>
          </WorktreeContextMenu>
        </div>
        <textarea aria-label="terminal input" />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
  fireEvent.contextMenu(screen.getByText('Card'))
  await screen.findByRole('menu')
}

describe('WorktreeContextMenu close focus', () => {
  it('keeps focus on the element an outside click moved it to', async () => {
    await openMenu()
    const terminal = screen.getByLabelText('terminal input')
    fireEvent.pointerDown(terminal)
    terminal.focus()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    // Radix dispatches close auto-focus on a timer after the content unmounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.activeElement).toBe(terminal)
  })

  it('returns focus to the sidebar when Escape closes the menu', async () => {
    await openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.activeElement).toBe(document.querySelector('[data-worktree-sidebar]'))
  })
})
