// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'

afterEach(() => {
  cleanup()
})

const session = { agent: 'claude' } as AiVaultSession

describe('SessionRowTrailingActions', () => {
  it('hides Play and offers jump and close when the session is already open', async () => {
    const onJumpToOriginalPane = vi.fn()
    const onCloseOriginalPane = vi.fn()
    const onResume = vi.fn()
    render(
      <TooltipProvider>
        <SessionRowTrailingActions
          session={session}
          detailsExpanded={false}
          detailsId="session-details"
          detailsTooltip="Show Details"
          resumeDisabled={false}
          resumeHidden
          resumeLabel="Resume in New Tab"
          worktreeInfo={null}
          onToggleDetails={vi.fn()}
          onJumpToOriginalPane={onJumpToOriginalPane}
          onCloseOriginalPane={onCloseOriginalPane}
          showJumpToWorktree={false}
          onResume={onResume}
          onCopyId={vi.fn()}
          deleteBlockedReason={null}
        />
      </TooltipProvider>
    )

    expect(screen.queryByTestId('ai-vault-session-resume')).toBeNull()
    fireEvent.click(screen.getByTestId('ai-vault-session-jump-original-pane'))
    fireEvent.click(screen.getByTestId('ai-vault-session-close-original-pane'))
    expect(onJumpToOriginalPane).toHaveBeenCalledOnce()
    expect(onCloseOriginalPane).toHaveBeenCalledOnce()
    expect(onResume).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Close Open Session' }))
    expect(onCloseOriginalPane).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('menuitem', { name: 'Resume in New Tab' })).toBeNull()
  })
})
