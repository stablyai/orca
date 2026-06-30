import {
  forEachSparseDirectoryInputLine,
  hasSparseDirectoryParentSegment,
  isAbsoluteSparseDirectoryPath,
  normalizeSparseDirectoryLines
} from '@/lib/sparse-paths'
import { translate } from '@/i18n/i18n'

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

export function parseSparsePresetDirectories(value: string): SparsePresetDirectoryParseResult {
  let hasAbsoluteEntry = false
  forEachSparseDirectoryInputLine(value, (rawEntry) => {
    const entry = rawEntry.trim()
    if (entry.length === 0) {
      return
    }
    if (isAbsoluteSparseDirectoryPath(entry)) {
      hasAbsoluteEntry = true
      return false
    }
    return undefined
  })

  // Why: absolute paths can look repo-relative after slash normalization.
  if (hasAbsoluteEntry) {
    return {
      directories: [],
      error: translate(
        'auto.lib.sparse.preset.draft.5915a0a1f6',
        'Use repo-relative directories, not root, absolute paths, or parent segments.'
      )
    }
  }

  const directories = normalizeSparseDirectoryLines(value)

  if (directories.length === 0) {
    return {
      directories,
      error: translate('auto.lib.sparse.preset.draft.efc05d1820', 'Add at least one directory.')
    }
  }

  if (directories.some((entry) => entry === '.' || hasSparseDirectoryParentSegment(entry))) {
    return {
      directories: [],
      error: translate(
        'auto.lib.sparse.preset.draft.5915a0a1f6',
        'Use repo-relative directories, not root, absolute paths, or parent segments.'
      )
    }
  }

  return {
    directories,
    error: null
  }
}
