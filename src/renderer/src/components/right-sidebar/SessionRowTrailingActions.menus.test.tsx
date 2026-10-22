// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'

afterEach(cleanup)

function renderRow(): ReactElement {
  return (
    <SessionRowTrailingActions
      session={{ agent: 'claude' } as AiVaultSession}
      detailsExpanded={false}
      detailsId="session-details"
      detailsTooltip="Show Details"
      resumeDisabled={false}
      resumeLabel="Resume in New Tab"
      worktreeInfo={null}
      onToggleDetails={vi.fn()}
      showJumpToWorktree={false}
      onResume={vi.fn()}
      onCopyId={vi.fn()}
      onCopyPath={vi.fn()}
      deleteBlockedReason={null}
      onRequestDelete={vi.fn()}
    />
  )
}

describe('SessionRowTrailingActions overflow menus', () => {
  it('closes one row menu when another row opens its menu', async () => {
    render(
      <TooltipProvider>
        {renderRow()}
        {renderRow()}
      </TooltipProvider>
    )
    const [first, second] = screen.getAllByTestId('ai-vault-session-more-actions')

    fireEvent.pointerDown(first, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(await screen.findAllByRole('menu')).toHaveLength(1)

    fireEvent.pointerDown(second, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  })
})
