import {
  hasSparseDirectoryParentSegment,
  isAbsoluteSparseDirectoryPath,
  normalizeSparseDirectoryLines
} from '@/lib/sparse-paths'
import { translate } from '@/i18n/i18n'

export type SparseDirectoryEntryInputResult = {
  entries: string[]
  error: string | null
}

/** Turn free-form typing or a multi-line paste into repo-relative entries,
 *  rejecting the same shapes the saved-preset parser rejects. */
export function parseSparseDirectoryEntryInput(raw: string): SparseDirectoryEntryInputResult {
  const invalid = {
    entries: [],
    error: translate(
      'auto.lib.sparse.preset.draft.5915a0a1f6',
      'Use repo-relative directories, not root, absolute paths, or parent segments.'
    )
  }
  if (raw.split('\n').some((line) => isAbsoluteSparseDirectoryPath(line))) {
    return invalid
  }
  const entries = normalizeSparseDirectoryLines(raw)
  if (entries.some((entry) => entry === '.' || hasSparseDirectoryParentSegment(entry))) {
    return invalid
  }
  return { entries, error: null }
}

/** Append entries that are not already selected, preserving existing order. */
export function addSparseDirectoryEntries(selected: string[], entries: string[]): string[] {
  const next = [...selected]
  for (const entry of entries) {
    if (!next.includes(entry)) {
      next.push(entry)
    }
  }
  return next
}
