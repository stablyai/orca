import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { resolveReviewRepository } from './review-owner'
import { resolveExactWorktreeRoute } from './worktree-owner-route'
import { forgeOwnerHostIdForWorkspace } from '../runtime/forge-credential-target'
import { findRepoForGitHubOwner } from '../store/github/repository-routing'

const proxy: Repo = {
  id: 'project',
  path: '/project',
  displayName: 'Project',
  badgeColor: 'blue',
  addedAt: 1,
  executionHostId: 'runtime:server',
  connectionId: 'builder'
}
const row = { id: 'project::/worktree', repoId: 'project', hostId: 'ssh:builder' as const }

describe('review repository evidence', () => {
  it.each(['local', 'ssh:other'] as const)(
    'ignores a stale connection beside explicit %s ownership',
    (executionHostId) => {
      const stale = { ...proxy, executionHostId }
      expect(resolveReviewRepository([stale], row)).toBeNull()
      expect(resolveReviewRepository([stale], row, stale)).toBeNull()
      expect(() => forgeOwnerHostIdForWorkspace(stale, row)).toThrow('owning host')
      expect(resolveReviewRepository([stale, proxy], row)).toBe(proxy)
      expect(resolveExactWorktreeRoute({ repos: [stale, proxy] }, row)).toMatchObject({
        kind: 'resolved',
        route: { runtimeEnvironmentId: 'server' }
      })
      const canonicalWorkspace = { ...row, hostId: executionHostId }
      expect(resolveReviewRepository([stale], canonicalWorkspace)).toBe(stale)
      expect(forgeOwnerHostIdForWorkspace(stale, canonicalWorkspace)).toBe(executionHostId)
    }
  )

  it('keeps generic ambiguity and direct review precedence while validating explicit context', () => {
    const direct = { ...proxy, executionHostId: 'ssh:builder' as const }
    const repos = [direct, proxy]
    expect(resolveExactWorktreeRoute({ repos }, row).kind).toBe('ambiguous')
    expect(resolveReviewRepository(repos, row)).toBe(direct)
    expect(resolveReviewRepository(repos, row, proxy)).toBe(proxy)
    expect(forgeOwnerHostIdForWorkspace(proxy, row)).toBe('runtime:server')
    expect(
      findRepoForGitHubOwner(
        { repos },
        proxy.id,
        proxy.path,
        forgeOwnerHostIdForWorkspace(proxy, row)
      )
    ).toBe(proxy)
    expect(() => forgeOwnerHostIdForWorkspace({ ...proxy, connectionId: 'other' }, row)).toThrow(
      'owning host'
    )
    expect(
      resolveReviewRepository(repos, { ...row, runtimeOwnerEnvironmentId: 'missing' })
    ).toBeNull()
  })

  it('retains connection evidence but refuses a host-only consumer for same-runtime repository twins', () => {
    const other = { ...proxy, connectionId: 'other' }
    const repos = [proxy, other]
    expect(resolveReviewRepository(repos, row)).toBe(proxy)
    expect(() =>
      findRepoForGitHubOwner(
        { repos },
        proxy.id,
        proxy.path,
        forgeOwnerHostIdForWorkspace(proxy, row)
      )
    ).toThrow('owning host')
    expect(resolveReviewRepository(repos, { ...row, runtimeOwnerEnvironmentId: 'server' })).toBe(
      proxy
    )
  })

  it('invalidates missing, resolved and ambiguous evidence with the repository snapshot', () => {
    const rival = { ...proxy, executionHostId: 'runtime:rival' as const }
    expect(resolveReviewRepository([], row)).toBeNull()
    expect(resolveReviewRepository([proxy], row)).toBe(proxy)
    expect(resolveReviewRepository([proxy, rival], row)).toBeNull()
    expect(resolveReviewRepository([rival], row)).toBe(rival)
    expect(resolveExactWorktreeRoute({ repos: [proxy, rival] }, row).kind).toBe('ambiguous')
    expect(resolveExactWorktreeRoute({ repos: [rival] }, row)).toMatchObject({
      kind: 'resolved',
      route: { runtimeEnvironmentId: 'rival' }
    })
  })

  it.each(['distinct', 'competing'] as const)(
    'does not re-enumerate a warmed %s repository snapshot as workspace count increases',
    (mode) => {
      let reads = 0
      const repos = Array.from({ length: 300 }, (_, i) => ({
        ...proxy,
        executionHostId: `runtime:server-${i}` as const,
        get id() {
          reads++
          return mode === 'distinct' ? `project-${i}` : 'project-299'
        }
      }))
      const workspace = { ...row, repoId: 'project-299' }
      resolveReviewRepository(repos, workspace)
      resolveExactWorktreeRoute({ repos }, workspace)
      reads = 0
      for (let i = 0; i < 400; i++) {
        expect(resolveReviewRepository(repos, workspace)).toBe(
          mode === 'distinct' ? repos[299] : null
        )
        expect(resolveExactWorktreeRoute({ repos }, workspace).kind).toBe(
          mode === 'distinct' ? 'resolved' : 'ambiguous'
        )
      }
      expect(reads).toBeLessThan(400 * 4)
    }
  )
})
