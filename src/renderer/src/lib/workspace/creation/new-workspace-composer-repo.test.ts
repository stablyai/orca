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

  it('never remaps a runtime checkout to a hidden sibling of the same project', () => {
    const upstream = { owner: 'o', repo: 'r' }
    const vm = repo('vm', { connectionId: 'runtime-ssh-orca-1', upstream })
    const hiddenSibling = repo('main', { upstream, hiddenAt: 1 })
    expect(resolveComposerSeedRepoId([vm, hiddenSibling], [vm, hiddenSibling], 'vm', [])).toBe('vm')
    // A listed sibling is still preferred over the per-workspace runtime checkout.
    const listedSibling = repo('main', { upstream })
    expect(resolveComposerSeedRepoId([vm, listedSibling], [vm, listedSibling], 'vm', [])).toBe(
      'main'
    )
  })
})
