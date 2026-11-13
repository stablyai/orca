import type { Worktree } from '../../../../../../shared/worktree/types'
import { isDisplayNamePersistencePending } from '../metadata/worktree-meta-persist'
import { branchName } from '@/lib/source-control/branches/branch-name'

export function preserveConcurrentManualOrder<T extends Worktree>(
  incoming: readonly T[],
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean
): T[] {
  if (!requestStarted || !current) {
    return [...incoming]
  }
  const startedById = new Map(
    requestStarted.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  const currentById = new Map(
    current.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  return incoming.map((worktree) => {
    const started = startedById.get(worktree.id)
    const latest = currentById.get(worktree.id)
    if (!started || !latest || started.manualOrder === latest.manualOrder) {
      return worktree
    }
    // Why: a refresh response may predate a completed drag; the renderer's optimistic rank is newer.
    return { ...worktree, manualOrder: latest.manualOrder }
  })
}

export function preserveConcurrentDisplayName<T extends Worktree>(
  incoming: readonly T[],
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean
): T[] {
  if (!requestStarted || !current) {
    return [...incoming]
  }
  const startedById = new Map(
    requestStarted.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  const currentById = new Map(
    current.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  return incoming.map((worktree) => {
    const started = startedById.get(worktree.id)
    const latest = currentById.get(worktree.id)
    if (!started || !latest) {
      return worktree
    }
    if (isDisplayNamePersistencePending(worktree.id, latest.hostId)) {
      return {
        ...worktree,
        displayName: latest.displayName,
        ...(latest.displayNameMode !== undefined
          ? { displayNameMode: latest.displayNameMode }
          : { displayNameMode: undefined })
      }
    }
    const latestChanged =
      latest.displayName !== started.displayName ||
      latest.displayNameMode !== started.displayNameMode
    // The label is the stable stale-response marker; mode may be absent on an
    // older host or newly projected by a newer one.
    const incomingIsStale = worktree.displayName === started.displayName
    const latestDisplayNameIsPinned =
      latest.displayNameMode === 'fixed' ||
      (latest.displayNameMode === undefined && latest.cliProvenance?.kind === 'created-by-cli')
    const incomingBranchShort = branchName(worktree.branch)
    // Old hosts re-derive automatic labels from branch (or path basename when detached);
    // any other label in their response is explicit meta a peer wrote there.
    const incomingLooksAutomatic =
      worktree.displayName === incomingBranchShort ||
      (incomingBranchShort === '' &&
        worktree.displayName === (worktree.path.split(/[\\/]/).pop() ?? ''))
    if (
      worktree.displayNameMode === undefined &&
      latestDisplayNameIsPinned &&
      incomingLooksAutomatic
    ) {
      // Older hosts omit provenance; never let their re-derived label replace a pinned one.
      return {
        ...worktree,
        displayName: latest.displayName,
        ...(latest.displayNameMode !== undefined
          ? { displayNameMode: latest.displayNameMode }
          : { displayNameMode: undefined })
      }
    }
    if (!latestChanged || !incomingIsStale) {
      return worktree
    }
    return {
      ...worktree,
      displayName: latest.displayName,
      ...(latest.displayNameMode !== undefined
        ? { displayNameMode: latest.displayNameMode }
        : { displayNameMode: undefined })
    }
  })
}
