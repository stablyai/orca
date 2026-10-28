import type { DirEntry } from './filesystem-entry-types'
import { compareDirEntries } from './file-name-sort'

/**
 * Where a page starts: strictly after this entry in the listing order. It needs `isDirectory`
 * because folders sort first, so a name alone cannot place an entry that was since deleted.
 */
export type DirEntryCursor = { name: string; isDirectory: boolean }

/** One page of a folder's sorted listing; `total` counts the whole folder as listed for it. */
export type DirEntryPage = { entries: DirEntry[]; total: number; hasMore: boolean }

/** The index of the first entry of `sorted` strictly after `after`; 0 without a cursor. */
export function dirEntryIndexAfter(
  sorted: readonly DirEntry[],
  after: DirEntryCursor | undefined
): number {
  if (!after) {
    return 0
  }
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareDirEntries(sorted[middle], after) <= 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/** One page of an already sorted listing, from just after `after`. */
export function dirEntryPageAfter(
  sorted: readonly DirEntry[],
  after: DirEntryCursor | undefined,
  limit: number
): DirEntryPage {
  const start = dirEntryIndexAfter(sorted, after)
  return {
    entries: sorted.slice(start, start + limit),
    total: sorted.length,
    hasMore: start + limit < sorted.length
  }
}

const TOO_MANY_FOR_REMOTE = 'too many to list over a remote connection.'

/** Every host build refuses an unpaged listing past the reply budget with this wording. */
export function dirListingTooLargeForRemoteMessage(entryCount: number): string {
  return `This folder has ${entryCount.toLocaleString('en-US')} entries, ${TOO_MANY_FOR_REMOTE}`
}

export function isDirListingTooLargeForRemoteError(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith(TOO_MANY_FOR_REMOTE)
}

/** The most entries a host returns in one page; even long names keep it far below a remote reply's cap. */
export const FILE_READ_DIR_MAX_PAGE_ENTRIES = 5_000
