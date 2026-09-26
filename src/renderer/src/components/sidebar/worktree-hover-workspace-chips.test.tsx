/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeHoverWorkspaceChips } from './worktree-hover-workspace-chips'

const mocks = vi.hoisted(() => ({ activityStatus: 'active' }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaceStatuses: [
        { id: 'in-progress', label: 'In progress', color: 'conductor-progress', icon: 'circle' }
      ]
    })
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mocks.activityStatus
}))

function render(node: React.JSX.Element): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
}

describe('WorktreeHoverWorkspaceChips', () => {
  beforeEach(() => {
    mocks.activityStatus = 'active'
  })

  it('names the board status the workspace sits in', () => {
    const markup = render(
      <WorktreeHoverWorkspaceChips worktreeId="wt-1" workspaceStatusId="in-progress" />
    )

    expect(markup).toContain('In progress')
    expect(markup).not.toContain('Sleeping')
  })

  it('says the workspace is asleep only when nothing is running in it', () => {
    expect(render(<WorktreeHoverWorkspaceChips worktreeId="wt-1" />)).toBe('')

    mocks.activityStatus = 'inactive'
    expect(render(<WorktreeHoverWorkspaceChips worktreeId="wt-1" />)).toContain('Sleeping')
  })

  it('ignores a status id no longer configured', () => {
    expect(
      render(<WorktreeHoverWorkspaceChips worktreeId="wt-1" workspaceStatusId="retired" />)
    ).toBe('')
  })
})
