/**
 * Issue #8784 — GHE PR avatars must prefer API avatar_url over github.com/{login}.png.
 *
 * Regression guard (was a repro that documented the broken path). After the fix:
 * - resolveGitHubUserAvatarSrc prefers API URLs
 * - PullRequestPage author uses authorAvatarUrl via GitHubUserAvatar
 * - TaskPage ReviewChipAvatar no longer hardcodes github.com login.png
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/github/repro-8784-ghe-avatar-fallback.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { githubAvatarUrl, resolveGitHubUserAvatarSrc } from './github-user-avatar'

describe('issue #8784 GHE avatar fallback (regression)', () => {
  it('prefers API avatar_url over login.png (GHE healthy path)', () => {
    const api = 'https://ghe.example.com/avatars/u/42?v=4'
    expect(resolveGitHubUserAvatarSrc('enterprise-only-user', api)).toBe(api)
  })

  it('trims whitespace-only avatarUrl and falls back to login.png for github.com', () => {
    expect(resolveGitHubUserAvatarSrc('octocat', '   ')).toBe(
      'https://github.com/octocat.png?size=64'
    )
    expect(resolveGitHubUserAvatarSrc('octocat', null)).toBe(githubAvatarUrl('octocat'))
  })

  it('returns null when neither avatarUrl nor login is usable (no bogus request)', () => {
    expect(resolveGitHubUserAvatarSrc('', '')).toBeNull()
    expect(resolveGitHubUserAvatarSrc('  ', null)).toBeNull()
  })

  it('login-only fallback still hardcodes public github.com png (github.com path)', () => {
    // Why: github.com users without avatar_url still use this; GHE relies on
    // enrichment + image onError → initials when this 404s.
    expect(githubAvatarUrl('corp-user')).toBe('https://github.com/corp-user.png?size=64')
  })

  it('source routes PR author/reviewer avatars through GitHubUserAvatar + authorAvatarUrl', () => {
    const prPage = readFileSync(join(__dirname, '../pull-request-page/page/header.tsx'), 'utf8')
    expect(prPage).toMatch(/GitHubUserAvatar/)
    expect(prPage).toMatch(/authorAvatarUrl/)
    // Why: author chip must not ignore API avatar_url and only pass login.
    expect(prPage).not.toMatch(/githubAvatarUrl\(workItem\.author\)/)

    const reviewChip = readFileSync(
      join(__dirname, '../task-page/github/github-assignee-avatars.tsx'),
      'utf8'
    )
    expect(reviewChip).toMatch(/GitHubUserAvatar/)
    // Why: list chip must not hardcode github.com/{login}.png.
    expect(reviewChip).not.toMatch(/github\.com\/\$\{reviewer\.login\}\.png/)
  })

  // GHES URLs can exist but fail unauthenticated; target slots need onError fallbacks.
  // Scope checks because TaskPage also renders non-GitHub provider avatars.
  const GITHUB_AVATAR_SLOTS = [
    {
      file: 'pull-request-page/reviewers/picker-row.tsx',
      fn: 'ReviewerPickerRow',
      login: 'reviewer.login',
      displayName: 'reviewer.name'
    },
    {
      file: 'pull-request-page/conversation/comment-card.tsx',
      fn: 'ConversationCommentCard',
      login: 'comment.author',
      displayName: null
    },
    {
      file: 'pull-request-page/mentions/textarea.tsx',
      fn: 'MentionTextarea',
      login: 'option.login',
      displayName: 'option.name'
    },
    {
      file: 'task-page/github/github-assignee-avatars.tsx',
      fn: 'GitHubAssigneeAvatar',
      login: 'assignee.login',
      displayName: 'assignee.name'
    },
    {
      file: 'task-page/github/github-assignees-cell.tsx',
      fn: 'GHAssigneesCell',
      login: 'user.login',
      displayName: 'user.name'
    },
    {
      file: 'task-page/github/pr-review-picker-panel.tsx',
      fn: 'PRReviewPickerPanel',
      login: 'reviewer.login',
      displayName: 'reviewer.name'
    }
  ] as const

  function componentBody(file: string, fn: string): string {
    const source = readFileSync(join(__dirname, '..', file), 'utf8')
    const start = source.indexOf(`function ${fn}`)
    expect(start, `${file}: function ${fn} not found`).toBeGreaterThanOrEqual(0)
    const next = source.indexOf('\nfunction ', start + 1)
    return source.slice(start, next === -1 ? undefined : next)
  }

  it.each(GITHUB_AVATAR_SLOTS)(
    'renders the $fn avatar through GitHubUserAvatar (#13976)',
    ({ file, fn, login }) => {
      const body = componentBody(file, fn)

      // Reject aliases and resolver expressions as well as direct avatarUrl fields.
      expect(body, `${fn} still renders a bare img`).not.toMatch(/<img[\s>]/)
      expect(body, `${fn} does not use GitHubUserAvatar`).toContain('<GitHubUserAvatar')
      expect(body, `${fn} does not pass its login`).toContain(`login={${login}}`)
    }
  )

  // Preserve two-letter initials when the fallback renders.
  it.each(GITHUB_AVATAR_SLOTS.filter((slot) => slot.displayName !== null))(
    'passes the $fn display name so initials are not reduced to one letter (#13976)',
    ({ file, fn, displayName }) => {
      expect(componentBody(file, fn)).toContain(`name={${displayName}}`)
    }
  )
})
