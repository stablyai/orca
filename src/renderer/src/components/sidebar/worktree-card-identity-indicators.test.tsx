// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { WorktreeCardIdentityBadges } from './worktree-card-header'

function IdentityIndicatorsFixture({
  hasHoverDetails = true
}: {
  hasHoverDetails?: boolean
}): React.JSX.Element {
  const detailsHoverControl = useWorktreeCardDetailsHoverControl()
  return (
    <TooltipProvider>
      <div data-worktree-card-hover-trigger="">
        <button onClick={() => detailsHoverControl.handleHoverOpenChange(true)}>Title</button>
        <button onClick={() => detailsHoverControl.handleReviewMenuOpenChange(true)}>
          Open review menu
        </button>
        <button onClick={() => detailsHoverControl.handleReviewMenuOpenChange(false)}>
          Close review menu
        </button>
        <div data-testid="details-state">{detailsHoverControl.hoverOpen ? 'open' : 'closed'}</div>
        <WorktreeCardIdentityBadges
          card={{
            worktree: makeWorktree({
              id: 'repo::/repo/primary',
              repoId: 'repo',
              isMainWorktree: true,
              isSparse: true,
              sparseDirectories: ['src/renderer']
            }),
            compactCards: false,
            newCardStyle: true,
            isFolder: false,
            detailsHoverControl
          }}
          hasHoverDetails={hasHoverDetails}
        />
      </div>
    </TooltipProvider>
  )
}

function findIndicatorTooltip(): Promise<Element> {
  return waitFor(() => {
    const element = document.querySelector('[data-slot="tooltip-content"]')
    if (!element) {
      throw new Error('Expected the sparse checkout tooltip')
    }
    return element
  })
}

afterEach(cleanup)

describe('worktree identity indicator tooltips', () => {
  it('dismisses the details when entering an indicator and restores them on the title', () => {
    render(<IdentityIndicatorsFixture />)
    const title = screen.getByRole('button', { name: 'Title' })
    const primary = screen.getByRole('img', { name: 'Primary worktree' })
    const sparse = screen.getByRole('img', { name: 'Sparse checkout' })
    const details = screen.getByTestId('details-state')

    fireEvent.click(title)
    expect(details.textContent).toBe('open')
    fireEvent.pointerEnter(primary)
    expect(details.textContent).toBe('closed')
    fireEvent.pointerLeave(primary, { relatedTarget: sparse })
    expect(details.textContent).toBe('closed')
    fireEvent.pointerLeave(sparse, { relatedTarget: title })
    expect(details.textContent).toBe('open')
  })

  it('hides the icon tooltip while an open menu holds the details card', async () => {
    render(<IdentityIndicatorsFixture />)
    const title = screen.getByRole('button', { name: 'Title' })
    const sparse = screen.getByRole('img', { name: 'Sparse checkout' })
    const openMenu = screen.getByRole('button', { name: 'Open review menu' })
    const details = screen.getByTestId('details-state')

    fireEvent.click(title)
    fireEvent.click(openMenu)
    act(() => sparse.focus())
    expect(details.textContent).toBe('open')
    const tooltip = await findIndicatorTooltip()
    expect(tooltip.classList.contains('hidden')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close review menu' }))
    expect(details.textContent).toBe('closed')
    expect(tooltip.classList.contains('hidden')).toBe(false)
  })

  it('shows the icon tooltip if no details card is mounted', async () => {
    render(<IdentityIndicatorsFixture hasHoverDetails={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Title' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open review menu' }))
    act(() => screen.getByRole('img', { name: 'Sparse checkout' }).focus())
    const tooltip = await findIndicatorTooltip()
    expect(tooltip.classList.contains('hidden')).toBe(false)
  })
})
