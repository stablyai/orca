/**
 * Issue #8784 — GHE PR avatars must prefer API avatar_url over github.com/{login}.png.
 *
 * Regression guard (was a repro that documented the broken path). After the fix:
 * - resolveGitHubUserAvatarSrc prefers API URLs
 * - PullRequestPage author uses authorAvatarUrl via GitHubUserAvatar
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/github/repro-8784-ghe-avatar-fallback.test.ts
 */
import { describe, expect, it } from 'vitest'
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
})
