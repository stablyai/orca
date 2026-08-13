import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { GIT_HISTORY_MAX_LIMIT, type GitHistoryResult } from '../../../../shared/git-history'
import { GitHistoryPanel } from './GitHistoryPanel'

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

  it('offers Load more commits when the history is truncated', () => {
    const result = makeHistoryResult()
    result.hasMore = true

    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onLoadMore={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    expect(markup).toContain('Load more commits')
  })

  it('hides Load more commits when every commit is already shown', () => {
    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result: makeHistoryResult() }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onLoadMore={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    // Anchor on a rendered row so the negative assertion cannot pass on empty markup.
    expect(markup).toContain('Fix tab overflow')
    expect(markup).not.toContain('Load more commits')
  })

  it('hides Load more commits at the git layer maximum, where paging cannot go further', () => {
    const result = makeHistoryResult()
    result.hasMore = true
    result.limit = GIT_HISTORY_MAX_LIMIT

    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onLoadMore={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    // Anchor on a rendered row so the negative assertion cannot pass on empty markup.
    expect(markup).toContain('Fix tab overflow')
    expect(markup).not.toContain('Load more commits')
  })

  it('omits Load more commits when no handler is wired', () => {
    const result = makeHistoryResult()
    result.hasMore = true

    const markup = renderToStaticMarkup(
      <GitHistoryPanel
        state={{ status: 'ready', result }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCommit={vi.fn()}
      />
    )

    // Anchor on a rendered row so the negative assertion cannot pass on empty markup.
    expect(markup).toContain('Fix tab overflow')
    expect(markup).not.toContain('Load more commits')
  })
})
