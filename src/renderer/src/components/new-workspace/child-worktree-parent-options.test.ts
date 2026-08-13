import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { WORKTREE_CREATE_PARENT_AUTHORITY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  getChildWorktreeParentCandidates,
  getDefaultChildWorktreeParentId,
  rankChildWorktreeParentCandidates,
  resolveChildWorktreeCreateParentId,
  resolvePreferredChildWorktreeParentId,
  sectionChildWorktreeParentCandidates,
  shouldShowChildWorktreeParentField,
  supportsChildWorktreeParentSelection
} from './child-worktree-parent-options'

function worktree(
  id: string,
  overrides: Partial<Worktree> & Pick<Worktree, 'displayName'>
): Worktree {
  const { displayName, ...rest } = overrides
  return {
    id,
    repoId: 'repo-1',
    projectId: 'project-1',
    hostId: 'local',
    displayName,
    path: `/worktrees/${id}`,
    branch: `refs/heads/${id}`,
    head: id,
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...rest
  }
}

describe('getChildWorktreeParentCandidates', () => {
  it('keeps only eligible worktrees on the selected project and execution host', () => {
    const current = worktree('current', { displayName: 'Current' })
    const legacy = worktree('legacy', { displayName: 'Legacy', projectId: undefined })
    const candidates = getChildWorktreeParentCandidates({
      worktrees: [
        current,
        legacy,
        worktree('other-project', { displayName: 'Other project', projectId: 'project-2' }),
        worktree('other-host', { displayName: 'Other host', hostId: 'ssh:server' }),
        worktree('archived', { displayName: 'Archived', isArchived: true }),
        worktree('other-repo', { displayName: 'Other repo', repoId: 'repo-2' })
      ],
      repoId: 'repo-1',
      projectId: 'project-1',
      executionHostId: 'local',
      repo: { connectionId: null, executionHostId: 'local' }
    })

    expect(candidates.map(({ id }) => id)).toEqual(['current', 'legacy'])
  })

  it('matches nested SSH worktrees through their paired runtime owner', () => {
    const nested = worktree('nested', {
      displayName: 'Nested',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'hub-1'
    })
    const foreign = worktree('foreign', {
      displayName: 'Foreign',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'hub-2'
    })

    const candidates = getChildWorktreeParentCandidates({
      worktrees: [nested, foreign],
      repoId: 'repo-1',
      projectId: 'project-1',
      executionHostId: 'runtime:hub-1',
      repo: { connectionId: 'private-target', executionHostId: 'runtime:hub-1' }
    })

    expect(candidates).toEqual([nested])
  })

  it('separates physical SSH targets transported through the same paired runtime', () => {
    const selectedTarget = worktree('selected-target', {
      displayName: 'Selected target',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'hub-1'
    })
    const siblingTarget = worktree('sibling-target', {
      displayName: 'Sibling target',
      hostId: 'ssh:other-target',
      runtimeOwnerEnvironmentId: 'hub-1'
    })

    const candidates = getChildWorktreeParentCandidates({
      worktrees: [selectedTarget, siblingTarget],
      repoId: 'repo-1',
      projectId: 'project-1',
      executionHostId: 'runtime:hub-1',
      repo: { connectionId: 'private-target', executionHostId: 'runtime:hub-1' }
    })

    expect(candidates).toEqual([selectedTarget])
  })

  it('does not leak paired-runtime worktrees into their physical client host', () => {
    const nested = worktree('nested', {
      displayName: 'Nested',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'hub-1'
    })

    expect(
      getChildWorktreeParentCandidates({
        worktrees: [nested],
        repoId: 'repo-1',
        projectId: 'project-1',
        executionHostId: 'ssh:private-target',
        repo: { connectionId: 'private-target', executionHostId: 'ssh:private-target' }
      })
    ).toEqual([])
  })
})

describe('shouldShowChildWorktreeParentField', () => {
  it('shows only for Git worktree targets', () => {
    expect(shouldShowChildWorktreeParentField(false, true, false)).toBe(true)
    expect(shouldShowChildWorktreeParentField(false, false, false)).toBe(false)
    expect(shouldShowChildWorktreeParentField(true, true, false)).toBe(false)
    expect(shouldShowChildWorktreeParentField(false, true, true)).toBe(false)
  })
})

describe('supportsChildWorktreeParentSelection', () => {
  it('allows local and direct SSH hosts without a runtime capability', () => {
    expect(supportsChildWorktreeParentSelection('local', undefined)).toBe(true)
    expect(supportsChildWorktreeParentSelection('ssh:server', undefined)).toBe(true)
  })

  it('fails closed for paired runtimes until the parent authority is advertised', () => {
    expect(supportsChildWorktreeParentSelection('runtime:hub', undefined)).toBe(false)
    expect(supportsChildWorktreeParentSelection('runtime:hub', [])).toBe(false)
    expect(
      supportsChildWorktreeParentSelection('runtime:hub', [
        WORKTREE_CREATE_PARENT_AUTHORITY_RUNTIME_CAPABILITY
      ])
    ).toBe(true)
  })
})

describe('rankChildWorktreeParentCandidates', () => {
  it('orders visited worktrees first, then falls back to activity and name', () => {
    const oldestVisited = worktree('visited-old', {
      displayName: 'Visited old',
      lastActivityAt: 10_000
    })
    const newestVisited = worktree('visited-new', {
      displayName: 'Visited new',
      lastActivityAt: 1
    })
    const active = worktree('active', { displayName: 'Active', lastActivityAt: 500 })
    const inactive = worktree('inactive', { displayName: 'Inactive', lastActivityAt: 100 })

    const ranked = rankChildWorktreeParentCandidates(
      [inactive, oldestVisited, active, newestVisited],
      '',
      { 'visited-old': 20, 'visited-new': 40 }
    )

    expect(ranked.map(({ id }) => id)).toEqual(['visited-new', 'visited-old', 'active', 'inactive'])
  })

  it('searches worktree names, branches, and paths', () => {
    const branchMatch = worktree('branch', {
      displayName: 'Checkout',
      branch: 'refs/heads/feature/payments'
    })
    const pathMatch = worktree('path', {
      displayName: 'API',
      path: '/worktrees/customer-portal'
    })

    expect(
      rankChildWorktreeParentCandidates([branchMatch, pathMatch], 'payments', {}).map(
        ({ id }) => id
      )
    ).toEqual(['branch'])
    expect(
      rankChildWorktreeParentCandidates([branchMatch, pathMatch], 'customer', {}).map(
        ({ id }) => id
      )
    ).toEqual(['path'])
  })
})

describe('sectionChildWorktreeParentCandidates', () => {
  it('puts the first four blank-query options in Recent', () => {
    const ranked = Array.from({ length: 6 }, (_, index) =>
      worktree(`wt-${index}`, { displayName: `Worktree ${index}` })
    )
    const sections = sectionChildWorktreeParentCandidates(ranked, '')

    expect(sections.map(({ key }) => key)).toEqual(['recent', 'all'])
    expect(sections[0]?.items.map(({ id }) => id)).toEqual(['wt-0', 'wt-1', 'wt-2', 'wt-3'])
    expect(sections[1]?.items.map(({ id }) => id)).toEqual(['wt-4', 'wt-5'])
  })

  it('uses one unsectioned result list while searching', () => {
    const candidate = worktree('wt-1', { displayName: 'Worktree' })
    expect(sectionChildWorktreeParentCandidates([candidate], 'work').map(({ key }) => key)).toEqual(
      ['results']
    )
  })
})

describe('child worktree parent defaults', () => {
  const recent = worktree('recent', { displayName: 'Recent' })
  const active = worktree('active', { displayName: 'Active' })

  it('defaults only when the active worktree is eligible', () => {
    const repo = { connectionId: null, executionHostId: 'local' as const }
    expect(getDefaultChildWorktreeParentId([recent, active], 'active', 'local', repo)).toBe(
      'active'
    )
    expect(getDefaultChildWorktreeParentId([recent, active], 'elsewhere', 'local', repo)).toBeNull()
    expect(getDefaultChildWorktreeParentId([recent, active], 'active', null, repo)).toBeNull()
  })

  it('uses physical and paired-runtime ownership to disambiguate an active id', () => {
    const nested = worktree('active', {
      displayName: 'Nested active',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'hub-1'
    })
    const repo = { connectionId: null, executionHostId: 'runtime:hub-1' as const }

    expect(getDefaultChildWorktreeParentId([nested], 'active', 'ssh:private-target', repo)).toBe(
      'active'
    )
    expect(getDefaultChildWorktreeParentId([nested], 'active', 'runtime:hub-1', repo)).toBe(
      'active'
    )
    expect(
      getDefaultChildWorktreeParentId([nested], 'active', 'ssh:different-target', repo)
    ).toBeNull()
  })

  it('preserves a valid choice and repairs an invalid choice to active or recent', () => {
    expect(resolvePreferredChildWorktreeParentId('recent', [recent, active], 'active')).toBe(
      'recent'
    )
    expect(resolvePreferredChildWorktreeParentId('gone', [recent, active], 'active')).toBe('active')
    expect(resolvePreferredChildWorktreeParentId('gone', [recent], null)).toBe('recent')
    expect(resolvePreferredChildWorktreeParentId('gone', [], null)).toBeNull()
  })

  it('preserves legacy inference until the child setting is explicitly changed', () => {
    expect(resolveChildWorktreeCreateParentId(false, false, null)).toBeUndefined()
    expect(resolveChildWorktreeCreateParentId(true, false, null)).toBeNull()
    expect(resolveChildWorktreeCreateParentId(true, true, 'parent')).toBe('parent')
  })
})
