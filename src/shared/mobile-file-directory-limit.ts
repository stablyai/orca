// Why: normal repositories stay complete while pathological fan-out/name payloads fail before retention.
export const MOBILE_FILE_DIRECTORY_MAX_ENTRIES = 10_000
export const MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES = 4 * 1024 * 1024
export const MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE =
  'This folder is too large to show safely on mobile (limit: 10,000 items or a 4 MB listing).'

type NamedDirectoryEntry = { name: string }

export type MobileFileDirectoryLimitState = {
  entries: number
  retainedBytes: number
}

export function createMobileFileDirectoryLimitState(): MobileFileDirectoryLimitState {
  return { entries: 0, retainedBytes: 0 }
}

export function trackMobileFileDirectoryEntry(
  state: MobileFileDirectoryLimitState,
  entry: NamedDirectoryEntry
): void {
  state.entries += 1
  state.retainedBytes += estimateMobileDirectoryEntryBytes(entry)
  if (
    state.entries > MOBILE_FILE_DIRECTORY_MAX_ENTRIES ||
    state.retainedBytes > MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES
  ) {
    throw new Error(MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE)
  }
}

export function assertMobileFileDirectoryWithinLimit(
  entries: readonly NamedDirectoryEntry[]
): void {
  const state = createMobileFileDirectoryLimitState()
  for (const entry of entries) {
    trackMobileFileDirectoryEntry(state, entry)
  }
}

export function estimateMobileDirectoryEntryBytes(entry: NamedDirectoryEntry): number {
  return entry.name.length * 2 + 64
}
