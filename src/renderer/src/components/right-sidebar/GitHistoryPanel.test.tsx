import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { GitHistoryResult } from '../../../../shared/git-history'
import { GitHistoryPanel } from './source-control/sync/git-history-panel'
import { formatGitHistoryTimestamp } from './source-control/sync/git-history-format'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const timestamp = new Date(2026, 5, 15, 12).getTime()

function makeHistoryResult(): GitHistoryResult {
  return {
    items: [
      {
        id: '52ad492abcd',
        parentIds: [],
        subject: 'Fix tab overflow',
        message: 'Fix tab overflow',
        displayId: '52ad492',
        author: 'Taylor',
        timestamp,
        references: []
      }
    ],
    currentRef: {
      id: 'refs/heads/main',
      name: 'main',
      revision: '52ad492abcd',
      category: 'branches'
    },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
}

describe('GitHistoryPanel', () => {
  it.each([Number.NaN, Number.MAX_VALUE])(
    'renders commits with malformed timestamp %s without crashing',
    (malformedTimestamp) => {
      const result = makeHistoryResult()
      result.items[0].timestamp = malformedTimestamp

      const markup = renderToStaticMarkup(
        <GitHistoryPanel
          state={{ status: 'ready', result }}
          collapsed={false}
          onToggle={vi.fn()}
          onRefresh={vi.fn()}
          onOpenCommit={vi.fn()}
        />
      )

      expect(markup).toContain('Fix tab overflow')
    }
  )

  // The dense row is subject-only; author and date now surface on expand, so the
  // collapsed row shows the subject and short id (the short id via aria-label).
  it('renders the commit subject row', () => {
    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result: makeHistoryResult() }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    expect(markup).toContain('Fix tab overflow')
    expect(markup).toContain('52ad492')
  })

  it('does not add native title tooltips alongside managed history tooltips', () => {
    const result = makeHistoryResult()
    result.items[0].references = [
      { id: 'refs/heads/main', name: 'main', category: 'branches' },
      { id: 'refs/heads/feature', name: 'feature', category: 'branches' },
      { id: 'refs/tags/v1.0.0', name: 'v1.0.0', category: 'tags' }
    ]

    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    expect(markup).not.toContain('title="Fix tab overflow"')
    expect(markup).not.toContain('title="main"')
    expect(markup).not.toContain('title="feature"')
    expect(markup).not.toContain('title="v1.0.0"')
    expect(markup).not.toMatch(/\stitle=/)
  })

  // The column is opt-in, so the collapsed row stays subject-only until a format is chosen.
  it('omits the commit time column until a format is chosen', () => {
    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result: makeHistoryResult() }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    expect(markup).not.toContain('git-history-commit-time')
  })

  it.each(['relative', 'absolute'] as const)(
    'shows the commit time column in the %s format, with the exact time on hover',
    (commitTimeFormat) => {
      const markup = renderToStaticMarkup(
        <GitHistoryPanel
          state={{ status: 'ready', result: makeHistoryResult() }}
          collapsed={false}
          commitTimeFormat={commitTimeFormat}
          onToggle={vi.fn()}
          onRefresh={vi.fn()}
          onOpenCommit={vi.fn()}
        />
      )

      expect(markup).toContain('data-testid="git-history-commit-time"')
      expect(markup).toContain(formatGitHistoryTimestamp(timestamp))
    }
  )

  it('leaves a malformed commit time out of the column instead of an empty cell', () => {
    const result = makeHistoryResult()
    result.items[0].timestamp = Number.MAX_VALUE

    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result }}
        collapsed={false}
        commitTimeFormat="absolute"
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    expect(markup).toContain('Fix tab overflow')
    expect(markup).not.toContain('git-history-commit-time')
  })
})
