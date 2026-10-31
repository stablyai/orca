import { clearRetiredEpochRepairs } from './retired-epoch-repair'
import type { SessionTabsPublicationEpochHistory } from '../web-session-tabs-sync/state'
import type { StructuredSessionTabPublicationVersion } from '../local-structured-session-tab-retirement'

// Track publisher generation, accepted per-worktree publications and one-shot restore. Every async entry rechecks its starting generation so reset fences in-flight responses.
let syncGeneration = 0
let sourceAddressRevision = 0
const retiredSourceAddresses = new Map<string, number>()

export function localSourceAddressRevision(): number {
  return sourceAddressRevision
}
export function isCurrentLocalSourceAddress(workspace: string, revision: number): boolean {
  return (retiredSourceAddresses.get(workspace) ?? 0) <= revision
}

export function retireLocalSourceAddress(workspace: string): void {
  retiredSourceAddresses.set(workspace, ++sourceAddressRevision)
  const version = localStructuredSessionVersionByWorktree.get(workspace)
  const history = localStructuredSessionEpochHistoryByWorktree.get(workspace)
  const epoch = version?.publicationEpoch ?? history?.current
  if (epoch) {
    localStructuredSessionEpochHistoryByWorktree.set(workspace, {
      current: null,
      retired: [...new Set([...(history?.retired ?? []), epoch])].slice(-8)
    })
  }
  localStructuredSessionVersionByWorktree.delete(workspace)
}

let restorePromise: Promise<void> | null = null

export const localStructuredSessionVersionByWorktree = new Map<
  string,
  StructuredSessionTabPublicationVersion
>()
export const localStructuredSessionEpochHistoryByWorktree = new Map<
  string,
  SessionTabsPublicationEpochHistory
>()

export function localStructuredSessionGeneration(): number {
  return syncGeneration
}

export function isCurrentLocalStructuredSessionGeneration(generation: number): boolean {
  return generation === syncGeneration
}

/** Latch the startup restore, releasing it on failure so a retry can re-run it. */
export function latchLocalStructuredSessionRestore(start: () => Promise<void>): Promise<void> {
  restorePromise ??= start().catch((error: unknown) => {
    restorePromise = null
    throw error
  })
  return restorePromise
}

export function retireLocalStructuredSessionGeneration(): void {
  syncGeneration += 1
  retiredSourceAddresses.clear()
  sourceAddressRevision = 0
  clearRetiredEpochRepairs()
  restorePromise = null
  localStructuredSessionVersionByWorktree.clear()
  localStructuredSessionEpochHistoryByWorktree.clear()
}

export const resetLocalStructuredSessionVersionForTests = retireLocalStructuredSessionGeneration
