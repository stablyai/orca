import { isAbsoluteSparseDirectoryPath, normalizeSparseDirectoryLines } from '@/lib/sparse-paths'

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

export function parseSparsePresetDirectories(value: string): SparsePresetDirectoryParseResult {
  const rawEntries = value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  // Why: absolute paths can look repo-relative after slash normalization.
  if (rawEntries.some(isAbsoluteSparseDirectoryPath)) {
    return {
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    }
  }

  const directories = normalizeSparseDirectoryLines(value)

  if (directories.length === 0) {
    return {
      directories,
      error: 'Add at least one directory.'
    }
  }

  if (directories.some((entry) => entry === '.' || entry.split('/').includes('..'))) {
    return {
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    }
  }

  return {
    directories,
    error: null
  }
}
