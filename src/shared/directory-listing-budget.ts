import type { DirEntry } from './filesystem-entry-types'

export const DIRECTORY_LISTING_MAX_ENTRIES = 100_000
export const DIRECTORY_LISTING_MAX_RETAINED_BYTES = 8 * 1024 * 1024

export class DirectoryListingCapacityError extends Error {
  readonly code = 'directory_listing_capacity'
  constructor() {
    super('Directory listing is too large to retain safely. Narrow the folder before retrying.')
    this.name = 'DirectoryListingCapacityError'
  }
}

export class DirectoryListingBudget {
  private entries = 0
  private retainedBytes = 0

  record(name: string): void {
    const bytes = name.length * 2 + 128
    if (
      this.entries >= DIRECTORY_LISTING_MAX_ENTRIES ||
      this.retainedBytes + bytes > DIRECTORY_LISTING_MAX_RETAINED_BYTES
    ) {
      throw new DirectoryListingCapacityError()
    }
    this.entries += 1
    this.retainedBytes += bytes
  }
}

export function validateDirectoryListing(result: unknown): DirEntry[] {
  if (!Array.isArray(result)) {
    throw new Error('Invalid directory listing')
  }
  const budget = new DirectoryListingBudget()
  const entries: DirEntry[] = []
  for (const entry of result) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.isDirectory !== 'boolean' ||
      typeof entry.isSymlink !== 'boolean'
    ) {
      throw new Error('Invalid directory listing entry')
    }
    budget.record(entry.name)
    entries.push({ name: entry.name, isDirectory: entry.isDirectory, isSymlink: entry.isSymlink })
  }
  return entries
}
