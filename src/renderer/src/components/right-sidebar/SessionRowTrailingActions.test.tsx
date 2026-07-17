import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'

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
      />
    </TooltipProvider>
  )
}

describe('SessionRowTrailingActions', () => {
  it('renders the always-visible new-session action when available', () => {
    const markup = renderActions(vi.fn())

    expect(markup).toContain('data-testid="ai-vault-session-continue-in-new-session"')
    expect(markup).toContain('aria-label="Continue in New Session…"')
  })

  it('omits the new-session action when the session has no valid target', () => {
    expect(renderActions()).not.toContain('data-testid="ai-vault-session-continue-in-new-session"')
  })
})
