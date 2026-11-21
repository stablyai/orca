// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import WorktreeCard from './WorktreeCard'

// main.css outlines a surface carrying this while its workspace menu is open.
const MENU_OPEN_ATTR = 'data-worktree-card-menu-open'
const declineConfirm = async (): Promise<boolean> => false

function renderCard(): HTMLElement {
  const worktree = makeWorktree({
    id: `${TEST_REPO.id}::/menu-ring`,
    repoId: TEST_REPO.id,
    path: '/menu-ring',
    displayName: 'menu-ring'
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] }
  })
  const { container } = render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <WorktreeCard
          worktree={worktree}
          repo={TEST_REPO}
          isActive={false}
          nativeDragEnabled={false}
        />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
  const surface = container.querySelector<HTMLElement>('[data-worktree-card-surface]')
  if (!surface) {
    throw new Error('no card surface')
  }
  return surface
}

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('a workspace card while its menu is open', () => {
  it('outlines the whole card, and drops the outline when the menu closes', () => {
    const surface = renderCard()
    expect(surface.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
    act(() => {
      fireEvent.contextMenu(surface)
    })
    expect(surface.getAttribute(MENU_OPEN_ATTR)).toBe('true')
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    expect(surface.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
  })
})
