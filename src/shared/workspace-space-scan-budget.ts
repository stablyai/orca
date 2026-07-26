export const WORKSPACE_SPACE_MAX_SCANNED_ENTRIES = 100_000
export const WORKSPACE_SPACE_MAX_RETAINED_SCAN_BYTES = 64 * 1024 * 1024

const WORKSPACE_SPACE_ENTRY_OVERHEAD_BYTES = 512

export type WorkspaceSpaceScanLimits = {
  maxEntries: number
  maxRetainedBytes: number
}

export type WorkspaceSpaceScanBudget = {
  entries: number
  retainedBytes: number
  limits: WorkspaceSpaceScanLimits
}

export class WorkspaceSpaceScanCapacityError extends Error {
  constructor() {
    super(
      'Workspace is too large to scan safely (limit: 100,000 entries or 64 MiB retained scan state)'
    )
    this.name = 'WorkspaceSpaceScanCapacityError'
  }
}

export function createWorkspaceSpaceScanBudget(
  requested?: Partial<WorkspaceSpaceScanLimits>
): WorkspaceSpaceScanBudget {
  return {
    entries: 0,
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

export function estimateWorkspaceSpaceEntryRetainedBytes(
  parentPath: string,
  entryName: string
): number {
  return (parentPath.length + entryName.length) * 2 + WORKSPACE_SPACE_ENTRY_OVERHEAD_BYTES
}

export function retainWorkspaceSpaceScanEntry(
  budget: WorkspaceSpaceScanBudget,
  parentPath: string,
  entryName: string
): void {
  const retainedBytes =
    budget.retainedBytes + estimateWorkspaceSpaceEntryRetainedBytes(parentPath, entryName)
  if (
    budget.entries >= budget.limits.maxEntries ||
    retainedBytes > budget.limits.maxRetainedBytes
  ) {
    throw new WorkspaceSpaceScanCapacityError()
  }
  budget.entries += 1
  budget.retainedBytes = retainedBytes
}

export async function collectWorkspaceSpaceDirectoryEntries<TEntry>(
  directory: AsyncIterable<TEntry> | Iterable<TEntry>,
  parentPath: string,
  entryName: (entry: TEntry) => string,
  budget: WorkspaceSpaceScanBudget,
  checkCancelled: () => void
): Promise<TEntry[]> {
  const entries: TEntry[] = []
  for await (const entry of directory) {
    checkCancelled()
    retainWorkspaceSpaceScanEntry(budget, parentPath, entryName(entry))
    entries.push(entry)
  }
  return entries
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
