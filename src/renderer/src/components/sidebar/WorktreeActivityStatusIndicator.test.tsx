import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeActivityStatusIndicator } from './WorktreeActivityStatusIndicator'

const mocks = vi.hoisted(() => ({
  status: 'inactive' as WorktreeStatus
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: vi.fn(() => mocks.status)
}))

function renderMarkup(status: WorktreeStatus): string {
  mocks.status = status
  return renderToStaticMarkup(
    <TooltipProvider>
      <WorktreeActivityStatusIndicator worktreeId="wt-child" />
    </TooltipProvider>
  )
}

describe('WorktreeActivityStatusIndicator', () => {
  beforeEach(() => {
    mocks.status = 'inactive'
  })

  it('renders the shared inactive status for slept worktrees', () => {
    const markup = renderMarkup('inactive')

    expect(markup).toContain('Inactive')
    expect(markup).toContain('bg-muted-foreground')
    expect(markup).not.toContain('bg-status-success')
  })

  it('renders the shared active status when the worktree is live', () => {
    const markup = renderMarkup('active')

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-status-success')
  })

  it('preserves a blocked worktree as destructive', () => {
    const markup = renderMarkup('blocked')

    expect(markup).toContain('Blocked')
    expect(markup).toContain('bg-destructive')
    expect(markup).not.toContain('bg-status-attention')
  })

  it('preserves an interrupted worktree as destructive', () => {
    const markup = renderMarkup('interrupted')

    expect(markup).toContain('Interrupted')
    expect(markup).toContain('bg-destructive')
    expect(markup).not.toContain('bg-status-success')
  })
})
