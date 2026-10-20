import type { WorkspaceCopyHolder } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'

export type CopyHolderGroup = {
  /** The outermost holder: the window or shell the user can find and close. */
  holder: WorkspaceCopyHolder
  /** Holders it started, directly or through each other. */
  started: WorkspaceCopyHolder[]
}

function parentOf(
  holder: WorkspaceCopyHolder,
  byPid: ReadonlyMap<number, WorkspaceCopyHolder>
): WorkspaceCopyHolder | null {
  const parent = holder.parentPid == null ? undefined : byPid.get(holder.parentPid)
  // Why: a parent pid can belong to a process that exited and whose pid was reused since.
  const reused =
    parent?.startedAt != null && holder.startedAt != null && parent.startedAt > holder.startedAt
  return parent && !reused ? parent : null
}

/** A shell and the agents and tools it started read as one entry, not one per process. */
export function groupCopyHolders(holders: readonly WorkspaceCopyHolder[]): CopyHolderGroup[] {
  const byPid = new Map(holders.map((holder) => [holder.pid, holder]))
  const groups = new Map<number, CopyHolderGroup>()
  for (const holder of holders) {
    const chain = [holder]
    let parent = parentOf(holder, byPid)
    while (parent && !chain.includes(parent)) {
      chain.push(parent)
      parent = parentOf(parent, byPid)
    }
    // A cycle (reused pids without start times) has no outermost process; any stable pick will do.
    const top = parent
      ? chain.reduce((lowest, next) => (next.pid < lowest.pid ? next : lowest))
      : (chain.at(-1) ?? holder)
    const group = groups.get(top.pid) ?? { holder: top, started: [] }
    if (holder !== top) {
      group.started.push(holder)
    }
    groups.set(top.pid, group)
  }
  return [...groups.values()]
}

/** `claude.exe, node.exe ×4`: each program once, with how many are running. */
export function countedProgramNames(holders: readonly WorkspaceCopyHolder[]): string {
  const counts = new Map<string, number>()
  for (const holder of holders) {
    counts.set(holder.name, (counts.get(holder.name) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ')
}

/** The held folder relative to the copy: '' for the copy's own folder, null when unknown. */
export function heldFolderInCopy(holder: WorkspaceCopyHolder, copyRoot: string): string | null {
  if (!holder.heldFolder) {
    return null
  }
  const root = copyRoot.replace(/[\\/]+$/, '')
  return holder.heldFolder.toLowerCase().startsWith(root.toLowerCase())
    ? holder.heldFolder.slice(root.length).replace(/^[\\/]+/, '')
    : holder.heldFolder
}
