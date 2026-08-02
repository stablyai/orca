import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReviewIcon } from './worktree-review-helpers'
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
})
