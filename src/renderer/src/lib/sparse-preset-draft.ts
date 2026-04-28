import { normalizeSparseDirectoryLines } from '@/lib/sparse-paths'

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

export function parseSparsePresetDirectories(value: string): SparsePresetDirectoryParseResult {
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
