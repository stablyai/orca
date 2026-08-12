import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('PullRequestPage avatar boundaries', () => {
  // Why: on private-mode GHE the stored avatar URL 302s to /login, so a bare <img>
  // renders a broken image. GitHubUserAvatar is the only path with an onError
  // fallback. See #8784.
  it('never renders a user avatar through a bare img', () => {
    const source = componentSource('PullRequestPage.tsx')

    expect(source).not.toMatch(/<img[^>]*\bsrc=\{[^}]*[aA]vatarUrl/)
  })

  it('routes the reviewer picker avatar through GitHubUserAvatar', () => {
    const section = sourceBetween(
      componentSource('PullRequestPage.tsx'),
      'function PRReviewersPanel',
      'const WORK_ITEM_DETAILS_CACHE_MAX'
    )

    expect(section).toContain('<GitHubUserAvatar')
    expect(section).toContain('login={reviewer.login}')
    expect(section).toContain('avatarUrl={reviewer.avatarUrl}')
  })

  it('routes the comment author avatar through GitHubUserAvatar', () => {
    const section = sourceBetween(
      componentSource('PullRequestPage.tsx'),
      'function ConversationTab',
      'function MentionTextarea'
    )

    expect(section).toContain('<GitHubUserAvatar')
    expect(section).toContain('login={comment.author}')
    expect(section).toContain('avatarUrl={comment.authorAvatarUrl}')
  })

  it('routes mention suggestion avatars through GitHubUserAvatar', () => {
    const section = sourceBetween(
      componentSource('PullRequestPage.tsx'),
      'function MentionTextarea',
      'function GHCommentComposer'
    )

    expect(section).toContain('<GitHubUserAvatar')
    expect(section).toContain('login={option.login}')
    expect(section).toContain('avatarUrl={option.avatarUrl}')
  })

  // Why: initials come from name when present, so dropping it silently degrades
  // the fallback to a single login letter.
  it('passes the display name where the source data carries one', () => {
    const source = componentSource('PullRequestPage.tsx')
    const reviewers = sourceBetween(
      source,
      'function PRReviewersPanel',
      'const WORK_ITEM_DETAILS_CACHE_MAX'
    )
    const mentions = sourceBetween(source, 'function MentionTextarea', 'function GHCommentComposer')

    expect(reviewers).toContain('name={reviewer.name}')
    expect(mentions).toContain('name={option.name}')
  })
})
