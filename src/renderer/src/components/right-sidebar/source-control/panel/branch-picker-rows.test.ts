import { describe, expect, it } from 'vitest'
import { buildBranchPickerRows } from './branch-picker-rows'
import type { GitLocalBranchListing } from '../../../../../../shared/git-local-branches'

const listing: GitLocalBranchListing = {
  current: 'main',
  branches: ['main', 'feature/login', 'release'],
  entries: [
    { name: 'main', worktreePath: '/repos/app' },
    { name: 'feature/login', worktreePath: '/repos/app-login' },
    { name: 'release' }
  ]
}

const SELF = '/repos/app'

describe('buildBranchPickerRows', () => {
  it('marks the checked-out branch as current rather than occupied', () => {
    const rows = buildBranchPickerRows({ listing, query: '', worktreePath: SELF })

    expect(rows[0]).toEqual({ kind: 'branch', name: 'main', isCurrent: true, occupiedBy: null })
  })

  it('names the workspace holding a branch checked out in another worktree', () => {
    const rows = buildBranchPickerRows({
      listing,
      query: '',
      worktreePath: SELF,
      worktreeLabelByPath: new Map([['/repos/app-login', 'Login work']])
    })

    expect(rows.find((row) => row.kind === 'branch' && row.name === 'feature/login')).toEqual({
      kind: 'branch',
      name: 'feature/login',
      isCurrent: false,
      occupiedBy: 'Login work'
    })
  })

  it('falls back to the raw path when no workspace matches the occupying worktree', () => {
    const rows = buildBranchPickerRows({ listing, query: '', worktreePath: SELF })

    expect(rows.find((row) => row.kind === 'branch' && row.name === 'feature/login')).toMatchObject({
      occupiedBy: '/repos/app-login'
    })
  })

  it('leaves a branch no worktree holds selectable', () => {
    const rows = buildBranchPickerRows({ listing, query: '', worktreePath: SELF })

    expect(rows.find((row) => row.kind === 'branch' && row.name === 'release')).toMatchObject({
      occupiedBy: null
    })
  })

  it('filters branches case-insensitively on the typed query', () => {
    const rows = buildBranchPickerRows({ listing, query: 'LOGIN', worktreePath: SELF })

    expect(rows.filter((row) => row.kind === 'branch').map((row) => row.name)).toEqual([
      'feature/login'
    ])
  })

  it('offers to create a branch for a name no local branch matches', () => {
    const rows = buildBranchPickerRows({ listing, query: 'new-thing', worktreePath: SELF })

    expect(rows.at(-1)).toEqual({ kind: 'create', name: 'new-thing', rejection: null })
  })

  it('does not offer to create a branch that already exists', () => {
    const rows = buildBranchPickerRows({ listing, query: 'release', worktreePath: SELF })

    expect(rows.some((row) => row.kind === 'create')).toBe(false)
  })

  it('offers no create row for an empty query', () => {
    const rows = buildBranchPickerRows({ listing, query: '   ', worktreePath: SELF })

    expect(rows.some((row) => row.kind === 'create')).toBe(false)
  })

  it('surfaces why a typed name cannot be created instead of hiding the row', () => {
    const rows = buildBranchPickerRows({ listing, query: 'bad..name', worktreePath: SELF })

    expect(rows.at(-1)).toEqual({
      kind: 'create',
      name: 'bad..name',
      rejection: 'invalid-characters'
    })
  })

  it('treats every branch as free when an older host reports no occupancy', () => {
    const legacy: GitLocalBranchListing = { current: 'main', branches: ['main', 'feature/login'] }

    const rows = buildBranchPickerRows({ listing: legacy, query: '', worktreePath: SELF })

    expect(rows).toEqual([
      { kind: 'branch', name: 'main', isCurrent: true, occupiedBy: null },
      { kind: 'branch', name: 'feature/login', isCurrent: false, occupiedBy: null }
    ])
  })

  it('compares worktree paths case- and separator-insensitively', () => {
    const windowsListing: GitLocalBranchListing = {
      current: 'main',
      branches: ['main'],
      entries: [{ name: 'main', worktreePath: 'C:/Repos/App' }]
    }

    const rows = buildBranchPickerRows({
      listing: windowsListing,
      query: '',
      worktreePath: 'C:\\Repos\\App'
    })

    expect(rows[0]).toMatchObject({ isCurrent: true, occupiedBy: null })
  })

  it('renders an empty list, not a crash, before the listing arrives', () => {
    expect(buildBranchPickerRows({ listing: null, query: '', worktreePath: SELF })).toEqual([])
  })

  it('still offers creation while the listing is loading', () => {
    const rows = buildBranchPickerRows({ listing: null, query: 'fresh', worktreePath: SELF })

    expect(rows).toEqual([{ kind: 'create', name: 'fresh', rejection: null }])
  })
})
