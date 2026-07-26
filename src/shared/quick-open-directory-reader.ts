import { lstat, opendir } from 'node:fs/promises'
import { isFileListingCancellation, throwIfFileListingCancelled } from './file-listing-cancellation'
import { isQuickOpenReadableDirectory } from './quick-open-directory-validation'
import {
  assertQuickOpenReaddirDeadline,
  consumeQuickOpenReaddirEntryBudget,
  consumeQuickOpenReaddirPathBudget,
  isQuickOpenReaddirBudgetError,
  type QuickOpenReaddirBudget
} from './quick-open-readdir-budget'

export type QuickOpenDirectoryEntry = {
  name: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
}

export async function readQuickOpenDirectoryEntries(opts: {
  absPath: string
  allowSymlinkedRoot: boolean
  budget: QuickOpenReaddirBudget
  signal?: AbortSignal
}): Promise<QuickOpenDirectoryEntry[]> {
  try {
    const stat = await lstat(opts.absPath)
    if (!isQuickOpenReadableDirectory(stat, opts.allowSymlinkedRoot)) {
      return []
    }

    const entries: QuickOpenDirectoryEntry[] = []
    const directory = await opendir(opts.absPath)
    throwIfFileListingCancelled(opts.signal)
    assertQuickOpenReaddirDeadline(opts.budget)
    for await (const entry of directory) {
      throwIfFileListingCancelled(opts.signal)
      assertQuickOpenReaddirDeadline(opts.budget)
      consumeQuickOpenReaddirEntryBudget(opts.budget)
      consumeQuickOpenReaddirPathBudget(opts.budget, entry.name)
      entries.push({
        name: entry.name,
        kind: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other'
      })
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    // Why: discard buffered names if the path became a symlink while its
    // directory handle was open; descendants must never escape the root.
    const statAfterRead = await lstat(opts.absPath)
    return isQuickOpenReadableDirectory(statAfterRead, opts.allowSymlinkedRoot) ? entries : []
  } catch (error) {
    if (isQuickOpenReaddirBudgetError(error) || isFileListingCancellation(error)) {
      throw error
    }
    // Permission denied or a vanished subtree must not hide readable siblings.
    return []
  }
}
