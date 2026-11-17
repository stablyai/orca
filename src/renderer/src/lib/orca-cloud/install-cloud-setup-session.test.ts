import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: [] }) } }))

import { githubRepoUrlFor, sessionNeedsFor, setupNeedsFrom } from './install-cloud-setup-session'

describe('cloud setup seam wiring', () => {
  it('maps a project remote to the setup session repository', () => {
    expect(githubRepoUrlFor('git@github.com:acme/web.git')).toBe('https://github.com/acme/web')
    expect(githubRepoUrlFor('https://github.com/acme/web')).toBe('https://github.com/acme/web')
    expect(githubRepoUrlFor('https://gitlab.com/acme/web')).toBeUndefined()
    expect(githubRepoUrlFor(null)).toBeUndefined()
  })

  it('keeps only the steps the setup session runs', () => {
    expect(setupNeedsFrom(['account', 'team', 'plan', 'github', 'agent'])).toEqual([
      'team',
      'plan',
      'github'
    ])
  })

  it('asks a signed-out start for GitHub access, which it could not check yet', () => {
    const repo = 'https://github.com/acme/web'
    expect(sessionNeedsFor(['account', 'plan', 'agent'], repo)).toEqual(['plan', 'github'])
    expect(sessionNeedsFor(['account', 'plan'], undefined)).toEqual(['plan'])
    // Signed in, the composer's own GitHub check already decided.
    expect(sessionNeedsFor(['plan'], repo)).toEqual(['plan'])
    expect(sessionNeedsFor(['plan', 'github'], undefined)).toEqual(['plan'])
  })
})
