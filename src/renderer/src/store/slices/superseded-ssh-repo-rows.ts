import type { Repo } from '../../../../shared/types'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'

/**
 * Drops repo rows left stranded on a removed SSH target after re-adoption
 * re-pointed the same repo onto a re-added host.
 *
 * Re-adoption (main) rewrites a repo's connectionId from the old (dead) target
 * id to the new one, but the renderer's per-host repo merge preserves rows on
 * "other hosts" — and the dead SSH host still looks like another host, so its
 * stale row lingers. A terminal pane bound to that ghost row then fails with
 * "SSH target not found".
 *
 * A row is superseded (and pruned) only when ALL hold:
 *  - it targets an SSH connection that is NOT a currently-known target, and
 *  - the same repo id also exists on a DIFFERENT host that IS known/live.
 *
 * This never removes a legitimate lone project-only ghost host (its repo id
 * exists only on the dead host, so there is no live sibling to supersede it) —
 * those are kept on purpose so the sidebar can still surface and forget them.
 */
export function pruneSupersededSshRepoRows(
  repos: readonly Repo[],
  knownSshTargetIds: ReadonlySet<string>
): Repo[] {
  const isDeadSshRow = (repo: Repo): boolean => {
    const connectionId = repo.connectionId?.trim()
    if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
      return false
    }
    return !knownSshTargetIds.has(connectionId)
  }

  // Repo ids that have at least one row on a known/live host (local or a live
  // SSH/runtime target). Only these can supersede a dead-host sibling.
  const idsWithLiveHost = new Set<string>()
  for (const repo of repos) {
    if (!isDeadSshRow(repo)) {
      idsWithLiveHost.add(repo.id)
    }
  }

  return repos.filter((repo) => {
    if (!isDeadSshRow(repo)) {
      return true
    }
    // Keep a lone ghost (no live sibling); drop only a superseded leftover.
    return !idsWithLiveHost.has(repo.id)
  })
}
