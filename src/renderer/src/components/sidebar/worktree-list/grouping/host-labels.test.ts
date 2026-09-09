import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getHostWorktreeCounts, getHostWorktreeIds } from './host-labels'

const LOCAL = 'local' as ExecutionHostId

function makeRepos(hostByRepo: Record<string, ExecutionHostId | undefined>): Map<string, Repo> {
  return new Map(
    Object.entries(hostByRepo).map(([id, executionHostId]) => [
      id,
      { id, path: `/${id}`, ...(executionHostId ? { executionHostId } : {}) } as Repo
    ])
  )
}

function makeWorktrees(rows: { id: string; repoId: string }[]): Worktree[] {
  return rows.map((row) => row as Worktree)
}

describe('host worktree counts and ids', () => {
  it('reports a count equal to the length of each host id list', () => {
    const repoMap = makeRepos({
      'repo-local': undefined,
      'repo-remote': 'ssh:other' as ExecutionHostId
    })
    const worktrees = makeWorktrees([
      { id: 'a', repoId: 'repo-local' },
      { id: 'b', repoId: 'repo-local' },
      { id: 'c', repoId: 'repo-remote' }
    ])

    const counts = getHostWorktreeCounts(worktrees, repoMap, LOCAL)
    const ids = getHostWorktreeIds(worktrees, repoMap, LOCAL)

    expect(ids).toBeDefined()
    expect(counts).toBeDefined()
    for (const [hostId, hostIds] of ids ?? []) {
      expect(counts?.get(hostId), `count for ${hostId}`).toBe(hostIds.length)
    }
    expect([...(counts?.keys() ?? [])].sort()).toEqual([...(ids?.keys() ?? [])].sort())
  })

  it('counts a repeated host identity once', () => {
    const repoMap = makeRepos({ 'repo-local': undefined })
    const worktrees = makeWorktrees([
      { id: 'a', repoId: 'repo-local' },
      { id: 'a', repoId: 'repo-local' },
      { id: 'b', repoId: 'repo-local' }
    ])

    expect(getHostWorktreeCounts(worktrees, repoMap, LOCAL)?.get(LOCAL)).toBe(2)
    expect(getHostWorktreeIds(worktrees, repoMap, LOCAL)?.get(LOCAL)).toEqual(['a', 'b'])
  })

  it('returns undefined for an empty lane', () => {
    const repoMap = makeRepos({})
    expect(getHostWorktreeCounts([], repoMap, LOCAL)).toBeUndefined()
    expect(getHostWorktreeIds([], repoMap, LOCAL)).toBeUndefined()
  })
})
