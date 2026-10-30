import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitHubIssueTimelineItem } from '../../../../../shared/github/comment-types'
import { renderTimelineActivityMessage } from './conversation-tab-timeline'

function messageText(activity: Partial<GitHubIssueTimelineItem>): string {
  const markup = renderToStaticMarkup(
    <>
      {renderTimelineActivityMessage({
        id: 'event-1',
        event: 'closed',
        actor: 'octocat',
        actorAvatarUrl: '',
        createdAt: '2026-01-01T00:00:00Z',
        ...activity
      })}
    </>
  )
  return markup.replace(/<[^>]+>/g, '')
}

describe('renderTimelineActivityMessage', () => {
  it('renders the close reason and closing pull request as one sentence', () => {
    expect(
      messageText({
        stateReason: 'not_planned',
        closer: { type: 'pr', number: 7, title: 'Fix it', url: 'https://example.com/7' }
      })
    ).toBe('octocat closed this as not planned in PR #7 Fix it')
  })

  it('renders project column moves without a missing source column', () => {
    expect(
      messageText({
        event: 'moved_columns_in_project',
        columnName: 'Done',
        projectName: 'Roadmap'
      })
    ).toBe('octocat moved this to Done in Roadmap')
  })
})
