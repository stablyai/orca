import {
  forEachSparseDirectoryInputLine,
  hasSparseDirectoryParentSegment,
  isAbsoluteSparseDirectoryPath,
  normalizeSparseDirectoryLines
} from './sparse-directory-paths'

const SPARSE_PRESET_NAME_MAX_LENGTH = 80

export type SparsePresetDirectoryProblem = 'repo-relative-required' | 'directory-required'

export function readSparsePresetDirectories(value: string): {
  directories: string[]
  problem: SparsePresetDirectoryProblem | null
} {
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
    return { directories: [], problem: 'repo-relative-required' }
  }
  const directories = normalizeSparseDirectoryLines(value)
  if (directories.length === 0) {
    return { directories, problem: 'directory-required' }
  }
  if (directories.some((entry) => entry === '.' || hasSparseDirectoryParentSegment(entry))) {
    return { directories: [], problem: 'repo-relative-required' }
  }
  return { directories, problem: null }
}

export type SparsePresetNameProblem =
  | { kind: 'required' }
  | { kind: 'too-long' }
  | { kind: 'exists'; name: string }

export function readSparsePresetNameProblem(
  name: string,
  presets: readonly { id: string; name: string }[],
  presetId?: string
): SparsePresetNameProblem | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return { kind: 'required' }
  }
  if (trimmed.length > SPARSE_PRESET_NAME_MAX_LENGTH) {
    return { kind: 'too-long' }
  }
  const collision = presets.find(
    (preset) => preset.id !== presetId && preset.name.toLowerCase() === trimmed.toLowerCase()
  )
  return collision ? { kind: 'exists', name: collision.name } : null
}
