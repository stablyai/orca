export const FILESYSTEM_DIRECTORY_MAX_ENTRIES = 100_000
export const FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES = 12 * 1024 * 1024
export const FILESYSTEM_DIRECTORY_LIMIT_MESSAGE =
  'This folder is too large to list safely (limit: 100,000 items or a 12 MB listing).'

export type FilesystemDirectoryListingLimits = {
  maxEntries: number
  maxRetainedBytes: number
}

type NamedDirectoryEntry = { name: string }

export type FilesystemDirectoryLimitState = {
  entries: number
  retainedBytes: number
  limits: FilesystemDirectoryListingLimits
}

export function resolveFilesystemDirectoryListingLimits(
  requested?: Partial<FilesystemDirectoryListingLimits>
): FilesystemDirectoryListingLimits {
  return {
    maxEntries: clampLimit(requested?.maxEntries, FILESYSTEM_DIRECTORY_MAX_ENTRIES),
    maxRetainedBytes: clampLimit(
      requested?.maxRetainedBytes,
      FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES
    )
  }
}

export function createFilesystemDirectoryLimitState(
  requested?: Partial<FilesystemDirectoryListingLimits>
): FilesystemDirectoryLimitState {
  return {
    entries: 0,
    retainedBytes: 0,
    limits: resolveFilesystemDirectoryListingLimits(requested)
  }
}

export function trackFilesystemDirectoryEntry(
  state: FilesystemDirectoryLimitState,
  entry: NamedDirectoryEntry
): void {
  state.entries += 1
  state.retainedBytes += estimateFilesystemDirectoryEntryBytes(entry)
  if (
    state.entries > state.limits.maxEntries ||
    state.retainedBytes > state.limits.maxRetainedBytes
  ) {
    throw new Error(FILESYSTEM_DIRECTORY_LIMIT_MESSAGE)
  }
}

export function assertFilesystemDirectoryWithinLimit(
  entries: readonly NamedDirectoryEntry[],
  requested?: Partial<FilesystemDirectoryListingLimits>
): void {
  const state = createFilesystemDirectoryLimitState(requested)
  for (const entry of entries) {
    trackFilesystemDirectoryEntry(state, entry)
  }
}

export function estimateFilesystemDirectoryEntryBytes(entry: NamedDirectoryEntry): number {
  // Why: this covers worst-case JSON escaping plus each result object's fixed overhead.
  return entry.name.length * 6 + 96
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
