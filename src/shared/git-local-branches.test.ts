import { describe, expect, it } from 'vitest'
import { LOCAL_BRANCH_LISTING_ARGV, parseLocalBranchListing } from './git-local-branches'

describe('parseLocalBranchListing', () => {
  it('reads the current branch from the HEAD marker and lists it first', () => {
    const listing = parseLocalBranchListing(['\tmain\t', '*\tfeature\t', '\trelease\t'].join('\n'))

    expect(listing.current).toBe('feature')
    expect(listing.branches).toEqual(['feature', 'main', 'release'])
  })

  it('records the worktree holding each branch and leaves free branches unmarked', () => {
    const listing = parseLocalBranchListing(
      ['*\tmain\t/repos/app', '\tfeature\t/repos/app-feature', '\tidle\t'].join('\n')
    )

    expect(listing.entries).toEqual([
      { name: 'main', worktreePath: '/repos/app' },
      { name: 'feature', worktreePath: '/repos/app-feature' },
      { name: 'idle' }
    ])
  })

  it('reports no current branch when HEAD is detached', () => {
    const listing = parseLocalBranchListing(['\tmain\t', '\tfeature\t'].join('\n'))

    expect(listing.current).toBeNull()
    expect(listing.branches).toEqual(['main', 'feature'])
  })

  it('skips blank and nameless lines rather than emitting empty branches', () => {
    const listing = parseLocalBranchListing(['', '\t\t', '*\tmain\t', ''].join('\n'))

    expect(listing.branches).toEqual(['main'])
  })

  it('handles an empty repository with no branches', () => {
    expect(parseLocalBranchListing('')).toEqual({ current: null, branches: [], entries: [] })
  })

  it('keeps branch names containing slashes intact', () => {
    const listing = parseLocalBranchListing('*\tfeat/nested/thing\t/repos/app')

    expect(listing.branches).toEqual(['feat/nested/thing'])
  })

  it('asks git for the worktree path, which the picker needs for occupancy', () => {
    expect(LOCAL_BRANCH_LISTING_ARGV).toContain(
      '--format=%(HEAD)%09%(refname:short)%09%(worktreepath)'
    )
  })
})
