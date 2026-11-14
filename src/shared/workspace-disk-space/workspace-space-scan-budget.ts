export const WORKSPACE_SPACE_MAX_SCANNED_ENTRIES = 100_000
export const WORKSPACE_SPACE_MAX_RETAINED_SCAN_BYTES = 64 * 1024 * 1024

const WORKSPACE_SPACE_ENTRY_OVERHEAD_BYTES = 512

export type WorkspaceSpaceScanLimits = {
  maxEntries: number
  maxRetainedBytes: number
}

/** Bound live retained bytes, releasing dispatched listings. maxEntries bounds one directory’s width; a traversal-wide entry count would incorrectly scale with worker concurrency. */
export type WorkspaceSpaceScanBudget = {
  retainedBytes: number
  limits: WorkspaceSpaceScanLimits
}

function formatLiveStateLimit(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024)
  return mebibytes >= 1
    ? `${Math.round(mebibytes * 10) / 10} MiB`
    : `${bytes.toLocaleString('en-US')} bytes`
}

export class WorkspaceSpaceScanCapacityError extends Error {
  constructor(limits: WorkspaceSpaceScanLimits) {
    super(
      `Workspace is too large to scan safely (limit: ${limits.maxEntries.toLocaleString('en-US')} entries or ${formatLiveStateLimit(limits.maxRetainedBytes)} of live scan state)`
    )
    this.name = 'WorkspaceSpaceScanCapacityError'
  }
}

export function createWorkspaceSpaceScanBudget(
  requested?: Partial<WorkspaceSpaceScanLimits>
): WorkspaceSpaceScanBudget {
  return {
    retainedBytes: 0,
    limits: {
      maxEntries: clampLimit(requested?.maxEntries, WORKSPACE_SPACE_MAX_SCANNED_ENTRIES),
      maxRetainedBytes: clampLimit(
        requested?.maxRetainedBytes,
        WORKSPACE_SPACE_MAX_RETAINED_SCAN_BYTES
      )
    }
  }
}

export function estimateWorkspaceSpaceEntryRetainedBytes(entryName: string): number {
  return entryName.length * 2 + WORKSPACE_SPACE_ENTRY_OVERHEAD_BYTES
}

/** Charge the shared parent path once per listing so checkout depth does not inflate per-entry cost. */
export function estimateWorkspaceSpaceListingRetainedBytes(parentPath: string): number {
  return parentPath.length * 2
}

export function retainWorkspaceSpaceScanEntry(
  budget: WorkspaceSpaceScanBudget,
  entryName: string,
  listingEntryCount: number,
  additionalBytes = 0
): void {
  const retainedBytes =
    budget.retainedBytes + estimateWorkspaceSpaceEntryRetainedBytes(entryName) + additionalBytes
  if (
    listingEntryCount >= budget.limits.maxEntries ||
    retainedBytes > budget.limits.maxRetainedBytes
  ) {
    throw new WorkspaceSpaceScanCapacityError(budget.limits)
  }
  budget.retainedBytes = retainedBytes
}

// Release dropped listings so the cap bounds live retention, not total traversal work.
export function releaseWorkspaceSpaceScanEntries(
  budget: WorkspaceSpaceScanBudget,
  retainedBytes: number
): void {
  budget.retainedBytes = Math.max(0, budget.retainedBytes - retainedBytes)
}

export type WorkspaceSpaceDirectoryAdmission<TEntry> = {
  entries: TEntry[]
  /** Charge held against the budget until the caller releases this listing. */
  retainedBytes: number
}

export async function collectWorkspaceSpaceDirectoryEntries<TEntry>(
  directory: AsyncIterable<TEntry> | Iterable<TEntry>,
  parentPath: string,
  entryName: (entry: TEntry) => string,
  budget: WorkspaceSpaceScanBudget,
  checkCancelled: () => void
): Promise<WorkspaceSpaceDirectoryAdmission<TEntry>> {
  const entries: TEntry[] = []
  let retainedBytes = 0
  try {
    for await (const entry of directory) {
      checkCancelled()
      const name = entryName(entry)
      // Charge the shared parent path with the first entry; empty listings hold no charge.
      const listingBytes =
        entries.length === 0 ? estimateWorkspaceSpaceListingRetainedBytes(parentPath) : 0
      retainWorkspaceSpaceScanEntry(budget, name, entries.length, listingBytes)
      retainedBytes += estimateWorkspaceSpaceEntryRetainedBytes(name) + listingBytes
      entries.push(entry)
    }
  } catch (error) {
    // Rejected/cancelled listings never reach a caller that could release their charge.
    releaseWorkspaceSpaceScanEntries(budget, retainedBytes)
    throw error
  }
  return { entries, retainedBytes }
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
