import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { resolveReviewRepository } from './review-owner'
import { resolveExactWorktreeRoute } from './worktree-owner-route'
import '../runtime/source-control/forge/forge-credential-target'
import '../store/github/repositories/repository-routing'

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
