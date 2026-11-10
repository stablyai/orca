import {
  hasSparseDirectoryParentSegment,
  isAbsoluteSparseDirectoryPath,
  normalizeSparseDirectoryLines
} from '@/lib/sparse-paths'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type SparseDirectoryEntryInputResult = {
  entries: string[]
  error: string | null
}

/** Parse typed/pasted repo-relative paths using saved-preset validation constraints. */
export function parseSparseDirectoryEntryInput(
  raw: string,
  t: Translate = translate
): SparseDirectoryEntryInputResult {
  const invalid = {
    entries: [],
    error: t(
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

export function addSparseDirectoryEntries(selected: string[], entries: string[]): string[] {
  const next = [...selected]
  for (const entry of entries) {
    if (!next.includes(entry)) {
      next.push(entry)
    }
  }
  return next
}
