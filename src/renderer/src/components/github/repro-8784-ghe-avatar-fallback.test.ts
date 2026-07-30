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
import { githubAvatarUrl } from './github-issue-comment-helpers'
import { resolveGitHubUserAvatarSrc } from './github-user-avatar'

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
    const prPage = readFileSync(join(__dirname, '../PullRequestPage.tsx'), 'utf8')
    expect(prPage).toMatch(/GitHubUserAvatar/)
    expect(prPage).toMatch(/authorAvatarUrl/)
    // Why: author chip must not ignore API avatar_url and only pass login.
    expect(prPage).not.toMatch(/githubAvatarUrl\(workItem\.author\)/)

    const taskPage = readFileSync(join(__dirname, '../TaskPage.tsx'), 'utf8')
    expect(taskPage).toMatch(/GitHubUserAvatar/)
    // Why: list chip must not hardcode github.com/{login}.png.
    expect(taskPage).not.toMatch(/github\.com\/\$\{reviewer\.login\}\.png/)
  })
})
