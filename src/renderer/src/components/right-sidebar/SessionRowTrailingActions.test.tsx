// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'

afterEach(() => {
  cleanup()
})

const session = { agent: 'claude' } as AiVaultSession

function renderActions(onContinueInNewSession?: () => void): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SessionRowTrailingActions
        session={session}
        detailsExpanded={false}
        detailsId="session-details"
        detailsTooltip="Show Details"
        resumeDisabled={false}
        resumeLabel="Resume in New Tab"
        worktreeInfo={null}
        onToggleDetails={vi.fn()}
        showJumpToWorktree={false}
        onResume={vi.fn()}
        onContinueInNewSession={onContinueInNewSession}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        deleteBlockedReason={null}
        onRequestDelete={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('SessionRowTrailingActions', () => {
  it('renders the new-session action as a hover-revealed control when available', () => {
    const markup = renderActions(vi.fn())

    expect(markup).toContain('data-testid="ai-vault-session-continue-in-new-session"')
    expect(markup).toContain('aria-label="Hand Off to Another Agent"')
    // Why: edge-usage action lives in the hover group; the gating class is what
    // keeps it click-proof while the row is unhovered.
    const buttonMarkup = markup.split('data-testid="ai-vault-session-continue-in-new-session"')[0]
    expect(buttonMarkup.slice(-600)).toContain('can-hover:pointer-events-none')
  })

  it('omits the new-session action when the session has no valid target', () => {
    expect(renderActions()).not.toContain('data-testid="ai-vault-session-continue-in-new-session"')
  })

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
