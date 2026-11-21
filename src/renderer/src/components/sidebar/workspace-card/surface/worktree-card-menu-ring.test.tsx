// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Worktree } from '../../../../../../shared/worktree/types'
import WorktreeCard from './WorktreeCard'

// main.css outlines a surface carrying this while its workspace menu is open.
const MENU_OPEN_ATTR = 'data-worktree-card-menu-open'
const declineConfirm = async (): Promise<boolean> => false

function worktreeNamed(name: string): Worktree {
  return makeWorktree({
    id: `${TEST_REPO.id}::/${name}`,
    repoId: TEST_REPO.id,
    path: `/${name}`,
    displayName: name
  })
}

/** A card, optionally with one nested child card; returns their surfaces, parent first. */
function renderCards(options: { nested?: boolean } = {}): {
  surfaces: HTMLElement[]
  unmount: () => void
} {
  const parent = worktreeNamed('menu-ring')
  const child = worktreeNamed('menu-ring-child')
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: options.nested ? [parent, child] : [parent] }
  })
  const { container, unmount } = render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <WorktreeCard
          worktree={parent}
          repo={TEST_REPO}
          isActive={false}
          nativeDragEnabled={false}
          lineageChildCount={options.nested ? 1 : 0}
          lineageChildren={
            options.nested ? (
              <WorktreeCard
                worktree={child}
                repo={TEST_REPO}
                isActive={false}
                nativeDragEnabled={false}
              />
            ) : undefined
          }
        />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
  const surfaces = Array.from(
    container.querySelectorAll<HTMLElement>('[data-worktree-card-surface]')
  )
  expect(surfaces.length).toBe(options.nested ? 2 : 1)
  return { surfaces, unmount }
}

function openMenuOn(target: Element): void {
  act(() => {
    fireEvent.contextMenu(target)
  })
  expect(screen.getByRole('menu')).toBeTruthy()
}

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('a workspace card while its menu is open', () => {
  it('is outlined until Escape dismisses the menu', () => {
    const [surface] = renderCards().surfaces
    expect(surface.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
    openMenuOn(surface)
    expect(surface.getAttribute(MENU_OPEN_ATTR)).toBe('true')
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    expect(surface.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
  })

  it('is outlined until a click outside dismisses the menu', async () => {
    const [surface] = renderCards().surfaces
    openMenuOn(surface)
    expect(surface.getAttribute(MENU_OPEN_ATTR)).toBe('true')
    // Radix arms its outside-pointer listener on the next tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => {
      fireEvent.pointerDown(document.body)
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(surface.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
  })

  it('starts without the outline when the card mounts again', () => {
    const first = renderCards()
    openMenuOn(first.surfaces[0])
    first.unmount()
    const [again] = renderCards().surfaces
    expect(again.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
  })

  it('outlines only the nested card whose menu is open', () => {
    const [parent, child] = renderCards({ nested: true }).surfaces
    openMenuOn(child)
    expect(child.getAttribute(MENU_OPEN_ATTR)).toBe('true')
    expect(parent.hasAttribute(MENU_OPEN_ATTR)).toBe(false)
  })
})
