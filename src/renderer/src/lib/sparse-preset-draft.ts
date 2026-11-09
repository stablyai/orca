import {
  forEachSparseDirectoryInputLine,
  hasSparseDirectoryParentSegment,
  isAbsoluteSparseDirectoryPath,
  normalizeSparseDirectoryLines
} from '@/lib/sparse-paths'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

export function parseSparsePresetDirectories(
  value: string,
  t: Translate = translate
): SparsePresetDirectoryParseResult {
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
      error: t(
        'auto.lib.sparse.preset.draft.5915a0a1f6',
        'Use repo-relative directories, not root, absolute paths, or parent segments.'
      )
    }
  }

  const directories = normalizeSparseDirectoryLines(value)

  if (directories.length === 0) {
    return {
      directories,
      error: t('auto.lib.sparse.preset.draft.efc05d1820', 'Add at least one directory.')
    }
  }

  if (directories.some((entry) => entry === '.' || hasSparseDirectoryParentSegment(entry))) {
    return {
      directories: [],
      error: t(
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

export function validateSparsePresetName(
  name: string,
  presets: readonly { id: string; name: string }[],
  presetId?: string,
  t: Translate = translate
): string | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return t('sparsePreset.nameRequired', 'Name is required.')
  }
  if (trimmed.length > 80) {
    return t('sparsePreset.nameTooLong', 'Name must be 80 characters or fewer.')
  }
  const collision = presets.find(
    (preset) => preset.id !== presetId && preset.name.toLowerCase() === trimmed.toLowerCase()
  )
  return collision
    ? t('sparsePreset.nameExists', 'A preset named “{{name}}” already exists.', {
        name: collision.name
      })
    : null
}
