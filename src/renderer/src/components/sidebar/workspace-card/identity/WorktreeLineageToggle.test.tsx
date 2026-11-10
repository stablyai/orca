import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { WorktreeLineageToggle } from './WorktreeLineageToggle'

const childStatuses = new Map<string, WorktreeStatus>([
  ['done-a', 'done'],
  ['done-b', 'done'],
  ['open', 'active'],
  ['busy', 'working']
])

vi.mock('../activity/use-worktree-activity-statuses', () => ({
  useWorktreeActivityStatuses: () => childStatuses
}))

function renderChip(props: { collapsed: boolean; hiddenUnreadCount?: number }): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <WorktreeLineageToggle
        childWorktreeIds={[...childStatuses.keys()]}
        ariaLabel="Show 4 child workspaces"
        label="4 children"
        count={4}
        {...props}
      />
    </TooltipProvider>
  )
}

function srDescription(markup: string): string | undefined {
  return /<span id="[^"]+" class="sr-only">([^<]*)<\/span>/.exec(markup)?.[1]
}

describe('WorktreeLineageToggle', () => {
  it('marks a collapsed chip with hidden unread children and counts them', () => {
    const markup = renderChip({ collapsed: true, hiddenUnreadCount: 3 })

    expect(markup).toContain('data-lineage-hidden-unread=""')
    expect(srDescription(markup)).toBe('1 Working, 2 Done · 3 unread')
  })

  it('leaves Active out so the green dot only means Done', () => {
    const markup = renderChip({ collapsed: true })

    expect(markup).not.toContain('data-child-worktree-status="active"')
    expect(markup).toContain('data-child-worktree-status="done"')
    expect(srDescription(markup)).toBe('1 Working, 2 Done')
  })

  it('shows no unread marker once the children are expanded or all read', () => {
    for (const markup of [
      renderChip({ collapsed: false, hiddenUnreadCount: 3 }),
      renderChip({ collapsed: true, hiddenUnreadCount: 0 })
    ]) {
      expect(markup).not.toContain('data-lineage-hidden-unread')
      expect(srDescription(markup)).toBe('1 Working, 2 Done')
    }
  })
})
