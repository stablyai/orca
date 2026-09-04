import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { applyWorktreeUpdates } from './worktree-meta-update-application'

// Two rows for one nested-SSH checkout, published through two paired runtimes: same id, same
// physical host, different canonical identities.
function row(key: string, colorTag: string | null): Worktree {
  return {
    id: 'repo::w',
    repoId: 'repo',
    hostId: 'ssh:box',
    identity: { key },
    colorTag
  } as unknown as Worktree
}

describe('applyWorktreeUpdates with an identity key', () => {
  it('updates only the row whose identity matches', () => {
    const next = applyWorktreeUpdates(
      { repo: [row('k-a', null), row('k-b', null)] },
      'repo::w',
      { colorTag: '#ef4444' },
      'ssh:box',
      'k-a'
    )
    expect(next.repo.map((worktree) => worktree.colorTag)).toEqual(['#ef4444', null])
  })

  // Regression: without a key the locator plus host matched both rows, so recoloring one
  // runtime-scoped card transiently recolored its sibling.
  it('still updates every matching row when no key is given, as before', () => {
    const next = applyWorktreeUpdates(
      { repo: [row('k-a', null), row('k-b', null)] },
      'repo::w',
      { colorTag: '#ef4444' },
      'ssh:box'
    )
    expect(next.repo.map((worktree) => worktree.colorTag)).toEqual(['#ef4444', '#ef4444'])
  })

  it('changes nothing when the key matches no row', () => {
    const before = { repo: [row('k-a', null)] }
    expect(applyWorktreeUpdates(before, 'repo::w', { colorTag: '#ef4444' }, 'ssh:box', 'k-z')).toBe(
      before
    )
  })
})
