import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorktreeCardController } from './use-worktree-card-controller'
import { buildWorktreeCardPresentation } from './worktree-card-presentation'

function makeCard(overrides: Partial<WorktreeCardController> = {}): WorktreeCardController {
  return {
    worktree: {
      id: 'repo-1::/repo/worktrees/review-number',
      repoId: 'repo-1',
      path: '/repo/worktrees/review-number',
      displayName: 'Show review number',
      branch: 'feature/review-number',
      head: 'abc123',
      isBare: false,
      isMainWorktree: false,
      comment: '',
      linkedIssue: null,
      linkedPR: 456,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1
    },
    newCardStyle: true,
    compactCards: false,
    isFolder: false,
    branch: 'feature/review-number',
    visibleCardTitle: 'Show review number',
    cardProps: ['pr'],
    workspacePorts: [],
    hasDetails: true,
    hasPorts: false,
    showStatus: false,
    showInlineAgentList: false,
    showLineageChildChip: false,
    showIdentityInNewCard: false,
    showDeleteQuickAction: false,
    metaReview: {
      provider: 'github',
      number: 456,
      title: 'Show review number',
      state: 'open',
      status: 'success',
      url: 'https://github.com/acme/orca/pull/456'
    },
    ...overrides
  } as WorktreeCardController
}

describe('worktree card review number presentation', () => {
  it('renders the selected review link in the new-style title row', () => {
    const presentation = buildWorktreeCardPresentation(makeCard())
    const markup = renderToStaticMarkup(<>{presentation.titleRowIndicators}</>)

    expect(markup).toContain('data-worktree-review-number=""')
    expect(markup).toContain('href="https://github.com/acme/orca/pull/456"')
    expect(markup).toContain('aria-label="Linked PR #456"')
    expect(markup).toContain('>#456</a>')
  })

  it('keeps the review number out of the card when the property is hidden', () => {
    const presentation = buildWorktreeCardPresentation(
      makeCard({ hasDetails: false, metaReview: null })
    )
    const markup = renderToStaticMarkup(<>{presentation.titleRowIndicators}</>)

    expect(markup).not.toContain('data-worktree-review-number')
    expect(markup).not.toContain('#456')
  })
})
