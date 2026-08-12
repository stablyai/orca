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

    const taskPage = readFileSync(join(__dirname, '../TaskPage.tsx'), 'utf8')
    expect(taskPage).toMatch(/GitHubUserAvatar/)
    // Why: list chip must not hardcode github.com/{login}.png.
    expect(taskPage).not.toMatch(/github\.com\/\$\{reviewer\.login\}\.png/)
  })

  // Why: #13976 — the reviewer picker, comment author and mention suggestions kept a
  // bare <img>, which only guarded on avatarUrl being absent. On private-mode GHE the
  // URL is present but 302s to /login in the renderer session, so the placeholder
  // branch never ran and a broken image stayed on screen.
  it('never renders a GitHub avatar through a bare img on the PR page (#13976)', () => {
    // Match the pattern, not specific field names: a rename or a newly added avatar
    // slot must not slip past this guard.
    const prPage = readFileSync(join(__dirname, '../PullRequestPage.tsx'), 'utf8')

    expect(prPage).not.toMatch(/<img[^>]*\bsrc=\{[^}]*[aA]vatarUrl/)
  })

  it('routes the TaskPage GitHub avatar cells through GitHubUserAvatar (#13976)', () => {
    // Why: scoped per function rather than whole-file, because TaskPage also renders
    // Linear member avatars, which have their own provider path and are out of scope.
    const taskPage = readFileSync(join(__dirname, '../TaskPage.tsx'), 'utf8')

    for (const name of ['GitHubAssigneeAvatar', 'GHAssigneesCell', 'PRReviewCell']) {
      const start = taskPage.indexOf(`function ${name}`)
      expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
      const next = taskPage.indexOf('\nfunction ', start + 1)
      const body = taskPage.slice(start, next === -1 ? undefined : next)

      expect(body, `${name} still renders a bare avatar img`).not.toMatch(
        /<img[^>]*\bsrc=\{[^}]*[aA]vatarUrl/
      )
      expect(body, `${name} does not use GitHubUserAvatar`).toContain('<GitHubUserAvatar')
    }
  })

  it('passes the display name so initials are not reduced to one letter (#13976)', () => {
    const prPage = readFileSync(join(__dirname, '../PullRequestPage.tsx'), 'utf8')

    // Why: GitHubUserAvatar derives 2-letter initials from `name` and falls back to
    // the login when it is missing, so dropping an available name degrades the
    // placeholder the GHE path depends on.
    expect(prPage).toMatch(/login=\{reviewer\.login\}[\s\S]{0,80}name=\{reviewer\.name\}/)
    expect(prPage).toMatch(/login=\{option\.login\}[\s\S]{0,80}name=\{option\.name\}/)
  })
})
