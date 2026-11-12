import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { resolveComposerSeedRepoId } from './new-workspace-composer-repo'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 0, ...overrides }
}

describe('resolveComposerSeedRepoId', () => {
  it('skips a loaded, hidden active project but keeps seeding while repos load', () => {
    expect(resolveComposerSeedRepoId([repo('a', { hiddenAt: 1 })], [], 'a', [])).toBeNull()
    // Repos not loaded yet: nothing says the active project is hidden, so it still seeds.
    expect(resolveComposerSeedRepoId([], [], 'a', [])).toBe('a')
    // Another host's copy is still listed.
    expect(
      resolveComposerSeedRepoId(
        [repo('a', { hiddenAt: 1 }), repo('a', { connectionId: 'box' })],
        [],
        'a',
        []
      )
    ).toBe('a')
  })
})
