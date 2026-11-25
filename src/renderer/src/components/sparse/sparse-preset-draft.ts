import {
  readSparsePresetDirectories,
  readSparsePresetNameProblem
} from '../../../../shared/worktree/creation/sparse-preset-draft-rules'
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
  const { directories, problem } = readSparsePresetDirectories(value)
  return {
    directories,
    error:
      problem === 'directory-required'
        ? t('auto.lib.sparse.preset.draft.efc05d1820', 'Add at least one directory.')
        : problem === 'repo-relative-required'
          ? t(
              'auto.lib.sparse.preset.draft.5915a0a1f6',
              'Use repo-relative directories, not root, absolute paths, or parent segments.'
            )
          : null
  }
}

export function validateSparsePresetName(
  name: string,
  presets: readonly { id: string; name: string }[],
  presetId?: string,
  t: Translate = translate
): string | null {
  const problem = readSparsePresetNameProblem(name, presets, presetId)
  switch (problem?.kind) {
    case 'required':
      return t('sparsePreset.nameRequired', 'Name is required.')
    case 'too-long':
      return t('sparsePreset.nameTooLong', 'Name must be 80 characters or fewer.')
    case 'exists':
      return t('sparsePreset.nameExists', 'A preset named “{{name}}” already exists.', {
        name: problem.name
      })
    case undefined:
      return null
  }
}
