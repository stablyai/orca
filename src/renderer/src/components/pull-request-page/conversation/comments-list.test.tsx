import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRCommentAudienceFilter } from '../../../../../shared/pr-comment-audience'
import { ConversationCommentsList } from './comments-list'

const comment: PRComment = {
  id: 1,
  author: 'coderabbitai',
  authorAvatarUrl: '',
  body: 'Please update this.',
  createdAt: '2026-09-17T00:00:00Z',
  url: 'https://github.com/stablyai/orca/pull/1#issuecomment-1',
  isBot: true
}

function renderComments({
  comments,
  commentFilter,
  commentCounts
}: {
  comments: PRComment[]
  commentFilter: PRCommentAudienceFilter
  commentCounts: Record<PRCommentAudienceFilter, number>
}): string {
  return renderToStaticMarkup(
    <ConversationCommentsList
      itemType="pr"
      comments={comments}
      visibleComments={[]}
      visibleCommentGroups={[]}
      commentFilter={commentFilter}
      commentCounts={commentCounts}
      repoPath="/tmp/orca"
      repoId="repo-1"
      reviewTitle="Improve comments"
      reviewUrl="https://github.com/stablyai/orca/pull/1"
      prNumber={1}
      prRepo={null}
      files={[]}
      headSha={undefined}
      baseSha={undefined}
      markdownGitHubRepo={null}
      mentionOptions={[]}
      resolvedReplyingTo={null}
      onFilterChange={vi.fn()}
      onToggleReply={vi.fn()}
      onSubmitReply={vi.fn(async () => true)}
    />
  )
}

function expectDisabledCopyButton(markup: string): void {
  expect(markup).toMatch(/<button[^>]*aria-label="Nothing to copy"[^>]*disabled=""/)
}

describe('ConversationCommentsList', () => {
  it('renders a disabled copy action for a pull request with no comments', () => {
    const markup = renderComments({
      comments: [],
      commentFilter: 'all',
      commentCounts: { all: 0, human: 0, bot: 0 }
    })

    expectDisabledCopyButton(markup)
  })

  it('disables copy when the active audience filter has no visible comments', () => {
    const markup = renderComments({
      comments: [comment],
      commentFilter: 'human',
      commentCounts: { all: 1, human: 0, bot: 1 }
    })

    expectDisabledCopyButton(markup)
    expect(markup).toContain('Humans')
  })
})
