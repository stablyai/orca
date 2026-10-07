import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReviewIcon } from './worktree-review-helpers'
import { ReviewDecisionBadge } from './WorktreeCardMetadataStatusBadges'
import { derivePipelineStatus } from '../../../../main/gitlab/mappers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const gitlabReview: WorktreeCardPrDisplay = {
  provider: 'gitlab',
  number: 456,
  title: 'Review me',
  state: 'open',
  status: 'pending'
}

describe('ReviewIcon', () => {
  it('uses the provider-specific GitLab MR icon by default', () => {
    const markup = renderToStaticMarkup(<ReviewIcon review={gitlabReview} className="size-3" />)

    expect(markup).toContain('lucide-git-merge')
  })

  it('can use the generic review icon for compact lanes', () => {
    const markup = renderToStaticMarkup(
      <ReviewIcon review={gitlabReview} className="size-3" variant="generic" />
    )

    expect(markup).toContain('viewBox="0 0 16 16"')
    expect(markup).not.toContain('lucide-git-merge')
  })

  // Why: an open MR with no explicit check tone falls through to the emerald "open" colour, so a
  // GitLab pipeline blocked on a manual gate must not resolve to a tone-less status — the card
  // would read exactly like a passing pipeline while GitLab still refuses the merge.
  it('does not paint a manual-blocked GitLab pipeline like a passing one', () => {
    const status = derivePipelineStatus({ status: 'manual' })
    const blocked = renderToStaticMarkup(
      <ReviewIcon review={{ ...gitlabReview, status }} className="size-3" />
    )
    const passing = renderToStaticMarkup(
      <ReviewIcon review={{ ...gitlabReview, status: 'success' }} className="size-3" />
    )

    expect(blocked).toContain('text-amber-500/85')
    expect(blocked).not.toContain('text-emerald-500/80')
    expect(blocked).not.toBe(passing)
  })

  // Why: #13088 — a draft with failing checks used the same glyph as every other
  // review and was painted red, so it was indistinguishable from a closed PR.
  it('gives a draft its own glyph and never paints it with a check tone', () => {
    const draft = renderToStaticMarkup(
      <ReviewIcon
        review={{
          provider: 'github',
          number: 1,
          title: 'Draft',
          state: 'draft',
          status: 'failure'
        }}
        className="size-3"
        variant="generic"
      />
    )
    const closed = renderToStaticMarkup(
      <ReviewIcon
        review={{ provider: 'github', number: 1, title: 'Closed', state: 'closed' }}
        className="size-3"
        variant="generic"
      />
    )

    expect(draft).toContain('lucide-git-pull-request-draft')
    expect(draft).not.toContain('text-rose-500/85')
    expect(closed).toContain('lucide-git-pull-request-closed')
    expect(draft).not.toBe(closed)
  })

  it('keeps check tones on open reviews so failing checks still stand out', () => {
    const failing = renderToStaticMarkup(
      <ReviewIcon
        review={{ provider: 'github', number: 1, title: 'Open', state: 'open', status: 'failure' }}
        className="size-3"
        variant="generic"
      />
    )

    expect(failing).toContain('text-rose-500/85')
  })

  it('renders merged reviews with the merge glyph', () => {
    const merged = renderToStaticMarkup(
      <ReviewIcon
        review={{ provider: 'github', number: 1, title: 'Merged', state: 'merged' }}
        className="size-3"
        variant="generic"
      />
    )

    expect(merged).toContain('lucide-git-merge')
  })

  // Why: a closed MR used to render the merge glyph, which read as "already merged".
  it('overrides the GitLab provider glyph for closed merge requests', () => {
    const closed = renderToStaticMarkup(
      <ReviewIcon review={{ ...gitlabReview, state: 'closed' }} className="size-3" />
    )

    expect(closed).toContain('lucide-git-pull-request-closed')
    expect(closed).not.toContain('lucide-git-merge')
  })

  // Why: folder cards render a stateless row while a linked review loads or its
  // details fail. There is no state glyph to contradict, so problems must still be
  // visible — but a tone-less row must not be promoted to a passing green.
  it('flags problems on a stateless row without ever claiming success', () => {
    const stateless = (status: 'failure' | 'pending' | 'success') =>
      renderToStaticMarkup(
        <ReviewIcon
          review={{ provider: 'github', number: 1, title: 'Loading PR...', status }}
          className="size-3"
        />
      )

    expect(stateless('failure')).toContain('text-rose-500/85')
    expect(stateless('pending')).toContain('text-amber-500/85')
    expect(stateless('success')).not.toContain('text-emerald-500/80')
  })
})

describe('review decision', () => {
  const openPR = (
    reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null,
    state: 'open' | 'merged' = 'open'
  ): WorktreeCardPrDisplay => ({
    provider: 'github',
    number: 1,
    title: 'PR',
    state,
    status: 'success',
    url: 'https://github.com/o/r/pull/1',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    reviewDecision
  })
  const icon = (review: WorktreeCardPrDisplay): string =>
    renderToStaticMarkup(<ReviewIcon review={review} className="size-3" />)
  const badge = (review: WorktreeCardPrDisplay): string =>
    renderToStaticMarkup(<ReviewDecisionBadge review={review} />)

  it('marks approved and changes-requested PRs with a dot separate from the CI tone', () => {
    expect(icon(openPR('APPROVED'))).toContain('bg-status-success')
    expect(icon(openPR('CHANGES_REQUESTED'))).toContain('bg-status-warning')
    expect(icon(openPR('CHANGES_REQUESTED'))).toContain('text-emerald-500/80')
  })

  it('leaves the icon undotted without a verdict or once the PR is finished', () => {
    for (const review of [
      openPR('REVIEW_REQUIRED'),
      openPR(null),
      openPR(undefined),
      openPR('APPROVED', 'merged')
    ]) {
      expect(icon(review)).not.toContain('data-review-decision-dot')
    }
  })

  it('labels each decision in the hover badge and hides it when absent', () => {
    expect(badge(openPR('APPROVED'))).toContain('Review: Approved')
    expect(badge(openPR('CHANGES_REQUESTED'))).toContain('Review: Changes requested')
    expect(badge(openPR('REVIEW_REQUIRED'))).toContain('Review: Required')
    expect(badge(openPR(null))).toBe('')
    expect(badge(openPR('APPROVED', 'merged'))).toBe('')
    expect(badge({ provider: 'github', number: 1, title: 'Loading PR...' })).toBe('')
  })
})
