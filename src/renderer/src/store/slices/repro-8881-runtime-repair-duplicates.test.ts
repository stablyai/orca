/**
 * Issue #8881 — Sidebar duplicates worktrees when re-paired hosts leave
 * stale runtime identities in the client store.
 *
 * Root cause chain:
 * 1. Worktree rows are keyed `${repoId}::${path}` — same physical path under
 *    two repoIds never collapses.
 * 2. mergeWorktreesForHost only replaces rows for the refreshing hostId and
 *    keeps sibling-host rows (including superseded runtime:<env> hosts).
 * 3. getProjectGroupingForRepo maps both repoIds to the same project: header,
 *    so both row sets render under one project.
 * 4. SSH has reconcileReadoptedSshRepoRows / reconcileReadoptedSshWorktreesByRepo;
 *    runtime re-pair has no equivalent.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/store/slices/repro-8881-runtime-repair-duplicates.test.ts
 */
import { describe, expect, it } from 'vitest'
import { WORKTREE_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { reconcileReadoptedSshRepoRows } from './superseded-ssh-repo-rows'
import { reconcileReadoptedSshWorktreesByRepo } from './readopted-ssh-worktree-rows'
import type { Repo, Worktree } from '../../../../shared/types'

/** Mirrors mergeWorktreesForHost in worktrees.ts (not exported). */
function mergeWorktreesForHost<T extends { hostId?: ExecutionHostId }>(
  current: readonly T[] | undefined,
  refreshed: readonly T[],
  hostId: ExecutionHostId
): T[] {
  const existing = current ?? []
  const next: T[] = []
  let inserted = false
  for (const worktree of existing) {
    if (worktree.hostId === hostId) {
      if (!inserted) {
        next.push(...refreshed)
        inserted = true
      }
      continue
    }
    next.push(worktree)
  }
  return inserted ? next : [...next, ...refreshed]
}

function worktreeId(repoId: string, path: string): string {
  return `${repoId}${WORKTREE_ID_SEPARATOR}${path}`
}

describe('#8881 runtime re-pair leaves duplicate worktree rows', () => {
  const pathA = '/Users/me/proj/feature-a'
  const pathB = '/Users/me/proj/feature-b'
  const pathC = '/Users/me/proj/main'
  const envOld = 'env-old-pair'
  const envNew = 'env-new-pair'
  const hostOld = toRuntimeExecutionHostId(envOld)
  const hostNew = toRuntimeExecutionHostId(envNew)
  const repoOld = 'repo-old'
  const repoNew = 'repo-new'

  it('mints distinct worktree ids for the same path under two repo identities', () => {
    const idOld = worktreeId(repoOld, pathA)
    const idNew = worktreeId(repoNew, pathA)
    expect(idOld).not.toBe(idNew)
    expect(idOld).toBe(`repo-old::${pathA}`)
    expect(idNew).toBe(`repo-new::${pathA}`)
  })

  it('mergeWorktreesForHost keeps superseded runtime host rows when a new env refreshes', () => {
    type Row = { id: string; hostId: ExecutionHostId; path: string }
    const stale: Row[] = [
      { id: worktreeId(repoOld, pathA), hostId: hostOld, path: pathA },
      { id: worktreeId(repoOld, pathB), hostId: hostOld, path: pathB },
      { id: worktreeId(repoOld, pathC), hostId: hostOld, path: pathC }
    ]
    const fresh: Row[] = [
      { id: worktreeId(repoNew, pathA), hostId: hostNew, path: pathA },
      { id: worktreeId(repoNew, pathB), hostId: hostNew, path: pathB },
      { id: worktreeId(repoNew, pathC), hostId: hostNew, path: pathC }
    ]

    // New host refresh only replaces hostNew rows (none yet) → appends, keeps old.
    const afterFirstPair = mergeWorktreesForHost(stale, fresh, hostNew)
    expect(afterFirstPair).toHaveLength(6)
    const paths = afterFirstPair.map((r) => r.path).sort()
    // Same 3 physical paths appear twice
    expect(paths.filter((p) => p === pathA)).toHaveLength(2)
    expect(paths.filter((p) => p === pathB)).toHaveLength(2)
    expect(paths.filter((p) => p === pathC)).toHaveLength(2)

    // Refresh of the new host still cannot purge the old host's rows
    const afterRefresh = mergeWorktreesForHost(afterFirstPair, fresh, hostNew)
    expect(afterRefresh).toHaveLength(6)
    expect(afterRefresh.filter((r) => r.hostId === hostOld)).toHaveLength(3)
  })

  it('same physical path under two runtime host/repo identities yields distinct worktree rows that both survive merge', () => {
    // Regardless of project-header key shape, the duplicate-row bug is that
    // merge keeps both host identities and ids never collide for same path.
    const hostOldRows = [pathA, pathB, pathC].map((p) => ({
      id: worktreeId(repoOld, p),
      path: p,
      hostId: hostOld,
      repoId: repoOld
    }))
    const hostNewRows = [pathA, pathB, pathC].map((p) => ({
      id: worktreeId(repoNew, p),
      path: p,
      hostId: hostNew,
      repoId: repoNew
    }))
    const merged = mergeWorktreesForHost([...hostOldRows, ...hostNewRows], hostNewRows, hostNew)
    expect(merged).toHaveLength(6)
    const paths = merged.map((r) => r.path)
    expect(paths.filter((p) => p === pathA)).toHaveLength(2)
    // No shared worktree.id across the two identities
    const ids = new Set(merged.map((r) => r.id))
    expect(ids.size).toBe(6)
  })

  it('SSH has a readoption reconcile; runtime re-pair has none in the same module family', () => {
    // Positive control: SSH reconcile prunes the old target once the new row exists
    const oldSsh = {
      id: 'r1',
      connectionId: 'ssh-old',
      executionHostId: 'ssh:ssh-old'
    } as Repo
    const newSsh = {
      id: 'r1',
      connectionId: 'ssh-new',
      executionHostId: 'ssh:ssh-new'
    } as Repo
    const result = reconcileReadoptedSshRepoRows(
      [oldSsh, newSsh],
      [{ oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['r1'] }]
    )
    expect(result.repos.map((r) => r.executionHostId)).toEqual(['ssh:ssh-new'])

    // Worktree-level SSH reconcile also exists
    expect(typeof reconcileReadoptedSshWorktreesByRepo).toBe('function')

    // No runtime analogue is exported from the readoption modules
    // (grep-level proof lives in the bug writeup — this asserts the SSH
    // tools don't silently handle runtime: hosts).
    const runtimeOnly = reconcileReadoptedSshRepoRows(
      [
        {
          id: 'r1',
          connectionId: null,
          executionHostId: hostOld
        } as Repo,
        {
          id: 'r1',
          connectionId: null,
          executionHostId: hostNew
        } as Repo
      ],
      []
    )
    // Without SSH readoption evidence, both runtime rows survive
    expect(runtimeOnly.repos).toHaveLength(2)
  })

  it('dedup by worktree.id cannot collapse same-path different-repoId rows', () => {
    const rows: Pick<Worktree, 'id' | 'path'>[] = [
      { id: worktreeId(repoOld, pathA), path: pathA },
      { id: worktreeId(repoNew, pathA), path: pathA }
    ]
    const byId = new Set(rows.map((r) => r.id))
    const byPath = new Set(rows.map((r) => r.path))
    expect(byId.size).toBe(2)
    expect(byPath.size).toBe(1)
  })
})
