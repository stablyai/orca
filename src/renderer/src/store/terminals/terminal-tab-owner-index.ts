import { createTerminalTabOwnerIndex } from './terminal-tab-owner-index-state'
import type { TerminalTabOwnerBuckets } from './terminal-tab-bucket-index'
export {
  createTerminalTabOwnerIndex,
  type TerminalTabOwnerIndex
} from './terminal-tab-owner-index-state'

const sharedTerminalTabOwnerIndex = createTerminalTabOwnerIndex()

export function getTerminalTabOwnerWorktreeIds(
  tabsByWorktree: TerminalTabOwnerBuckets,
  tabId: string
): Iterable<string> {
  return sharedTerminalTabOwnerIndex.getOwnerIds(tabsByWorktree, tabId)
}

export function getFirstTerminalTabOwnerWorktreeId(
  tabsByWorktree: TerminalTabOwnerBuckets,
  tabId: string
): string | null {
  return sharedTerminalTabOwnerIndex.getFirstOwner(tabsByWorktree, tabId)
}

export function getFirstTerminalTab<T extends { id: string }>(
  buckets: TerminalTabOwnerBuckets<T>,
  tabId: string
): T | undefined {
  return sharedTerminalTabOwnerIndex.getFirstTab(buckets, tabId)
}

export function terminalTabHasOwnerOutside(
  buckets: TerminalTabOwnerBuckets,
  tabId: string,
  expectedWorkspaceId: string
): boolean {
  return sharedTerminalTabOwnerIndex.hasOwnerOutside(buckets, tabId, expectedWorkspaceId)
}

export function getTerminalTabOwners(
  tabsByWorktree: TerminalTabOwnerBuckets
): ReadonlyMap<string, string> {
  return sharedTerminalTabOwnerIndex.getOwners(tabsByWorktree)
}

export function getTerminalTabOwnerWorktreeId(
  tabsByWorktree: TerminalTabOwnerBuckets,
  tabId: string
): string | null {
  return sharedTerminalTabOwnerIndex.getOwner(tabsByWorktree, tabId)
}

export function adoptTerminalTabOwnerMetadataOnlyBuckets(
  previousTabsByWorktree: TerminalTabOwnerBuckets,
  nextTabsByWorktree: TerminalTabOwnerBuckets,
  replacedWorktreeIds: Iterable<string>
): void {
  sharedTerminalTabOwnerIndex.adoptMetadataOnlyBucketReplacements(
    previousTabsByWorktree,
    nextTabsByWorktree,
    replacedWorktreeIds
  )
}

export function getTerminalTab<T extends { id: string }>(
  buckets: TerminalTabOwnerBuckets<T>,
  tabId: string
): T | undefined {
  return sharedTerminalTabOwnerIndex.getTab(buckets, tabId)
}

export function getLastTerminalTab<T extends { id: string }>(
  buckets: TerminalTabOwnerBuckets<T>,
  tabId: string
): T | undefined {
  return sharedTerminalTabOwnerIndex.getLastTab(buckets, tabId)
}

export function getTerminalTabRows<T extends { id: string }>(
  buckets: TerminalTabOwnerBuckets<T>,
  tabId: string
): T[] {
  return sharedTerminalTabOwnerIndex.getRows(buckets, tabId)
}
