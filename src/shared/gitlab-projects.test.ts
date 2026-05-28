import { describe, expect, it } from 'vitest'
import { computeNextGitLabRecents, GITLAB_RECENTS_MAX } from './gitlab-projects'

describe('computeNextGitLabRecents', () => {
  const fixedNow = new Date('2026-05-08T10:00:00.000Z')

  it('prepends a fresh entry to an empty list', () => {
    expect(computeNextGitLabRecents([], 'gitlab.com', 'g/p', fixedNow)).toEqual([
      { host: 'gitlab.com', path: 'g/p', lastOpenedAt: fixedNow.toISOString() }
    ])
  })

  it('moves an existing entry to the front (dedupes by host + path)', () => {
    const existing = [
      { host: 'gitlab.com', path: 'a/b', lastOpenedAt: '2026-05-07' },
      { host: 'gitlab.com', path: 'g/p', lastOpenedAt: '2026-05-06' },
      { host: 'gitlab.com', path: 'c/d', lastOpenedAt: '2026-05-05' }
    ]
    const result = computeNextGitLabRecents(existing, 'gitlab.com', 'g/p', fixedNow)
    expect(result.map((r) => r.path)).toEqual(['g/p', 'a/b', 'c/d'])
    expect(result[0].lastOpenedAt).toBe(fixedNow.toISOString())
  })

  it('treats different hosts at the same path as distinct entries', () => {
    const existing = [{ host: 'gitlab.example.com', path: 'g/p', lastOpenedAt: '2026-05-07' }]
    const result = computeNextGitLabRecents(existing, 'gitlab.com', 'g/p', fixedNow)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ host: 'gitlab.com', path: 'g/p' })
    expect(result[1]).toMatchObject({ host: 'gitlab.example.com', path: 'g/p' })
  })

  it('caps the list at GITLAB_RECENTS_MAX entries', () => {
    const existing = Array.from({ length: GITLAB_RECENTS_MAX }, (_, i) => ({
      host: 'gitlab.com',
      path: `g/p${i}`,
      lastOpenedAt: `2026-05-0${i}`
    }))
    const result = computeNextGitLabRecents(existing, 'gitlab.com', 'g/new', fixedNow)
    expect(result).toHaveLength(GITLAB_RECENTS_MAX)
    expect(result[0].path).toBe('g/new')
    // Why: oldest entry (the one that was at the tail before the prepend)
    // must be the one that fell off — verify by checking it's no longer
    // in the result.
    expect(result.find((r) => r.path === `g/p${GITLAB_RECENTS_MAX - 1}`)).toBeUndefined()
  })

  it('does not mutate the input array', () => {
    const existing = [{ host: 'gitlab.com', path: 'a/b', lastOpenedAt: '2026-05-07' }]
    const snapshot = JSON.stringify(existing)
    computeNextGitLabRecents(existing, 'gitlab.com', 'g/p', fixedNow)
    expect(JSON.stringify(existing)).toBe(snapshot)
  })
})
