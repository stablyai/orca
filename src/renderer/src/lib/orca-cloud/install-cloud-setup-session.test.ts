import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: [] }) } }))

import { githubRepoUrlFor, setupNeedsFrom } from './install-cloud-setup-session'

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
})
