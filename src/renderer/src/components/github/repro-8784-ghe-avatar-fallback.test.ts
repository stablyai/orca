/**
 * Issue #8784 — GHE PR avatars built from github.com/{login}.png instead of API avatar_url.
 *
 * When avatarUrl is missing/empty, UI falls back to public github.com avatars which 404
 * for Enterprise-only logins. PullRequestPage author chip even ignores avatar_url entirely.
 *
 * Related fix PR: https://github.com/stablyai/orca/pull/8831
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/github/repro-8784-ghe-avatar-fallback.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { githubAvatarUrl } from './github-issue-comment-helpers'

/** Mirrors TaskPage ReviewChipAvatar resolution (TaskPage.tsx). */
export function resolveReviewerAvatarUrl(reviewer: {
  login: string
  avatarUrl?: string | null
}): string {
  return reviewer.avatarUrl || `https://github.com/${reviewer.login}.png?size=40`
}

/** Mirrors PullRequestPage ReviewerAvatar resolution. */
export function resolveReviewerAvatarSrc(login: string, avatarUrl: string): string {
  return avatarUrl || githubAvatarUrl(login)
}

describe('issue #8784 GHE avatar fallback', () => {
  it('falls back to github.com/{login}.png when avatarUrl empty — wrong for GHE users', () => {
    const gheOnly = { login: 'enterprise-only-user', avatarUrl: '' }
    const url = resolveReviewerAvatarUrl(gheOnly)
    expect(url).toBe('https://github.com/enterprise-only-user.png?size=40')
    expect(url.startsWith('https://github.com/')).toBe(true)
  })

  it('prefers API avatar_url when present (healthy path for TaskPage)', () => {
    const api = {
      login: 'enterprise-only-user',
      avatarUrl: 'https://ghe.example.com/avatars/u/42?v=4'
    }
    expect(resolveReviewerAvatarUrl(api)).toBe('https://ghe.example.com/avatars/u/42?v=4')
  })

  it('production githubAvatarUrl hardcodes public github.com png from login', () => {
    expect(githubAvatarUrl('corp-user')).toBe('https://github.com/corp-user.png?size=64')
    // Enterprise login does not exist on github.com → 404
    expect(githubAvatarUrl('enterprise-only-user')).toMatch(/^https:\/\/github\.com\//)
  })

  it('ReviewerAvatar falls back to login png when API avatar empty (GHE broken path)', () => {
    const src = resolveReviewerAvatarSrc('ghe-reviewer', '')
    expect(src).toBe('https://github.com/ghe-reviewer.png?size=64')
  })

  it('ReviewerAvatar prefers API avatar_url when provided', () => {
    const apiUrl = 'https://avatars.ghe.example.com/u/99?v=4'
    expect(resolveReviewerAvatarSrc('ghe-reviewer', apiUrl)).toBe(apiUrl)
  })

  it('source still builds github.com login.png and author ignores avatar_url', () => {
    const taskPage = readFileSync(join(__dirname, '../TaskPage.tsx'), 'utf8')
    expect(taskPage).toMatch(/github\.com\/\$\{reviewer\.login\}\.png/)

    const helpers = readFileSync(join(__dirname, 'github-issue-comment-helpers.ts'), 'utf8')
    expect(helpers).toMatch(/github\.com\/\$\{encodeURIComponent\(login\)\}\.png/)

    // Why: author chip only passes login into githubAvatarUrl — never API avatar_url.
    const prPage = readFileSync(join(__dirname, '../PullRequestPage.tsx'), 'utf8')
    expect(prPage).toMatch(/githubAvatarUrl\(workItem\.author\)/)
    expect(prPage).toMatch(/avatarUrl \|\| githubAvatarUrl\(login\)/)
  })
})
