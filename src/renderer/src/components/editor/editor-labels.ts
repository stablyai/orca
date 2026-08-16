import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'

type EditorLabelVariant = 'fileName' | 'relativePath' | 'fullPath'

function getBaseLabel(file: OpenFile, variant: EditorLabelVariant): string {
  switch (variant) {
    case 'fullPath':
      return file.filePath
    case 'relativePath':
      return file.relativePath
    case 'fileName':
      return basename(file.relativePath)
  }
}

const DIFF_SOURCE_I18N_KEYS: Record<string, { key: string; fallback: string }> = {
  staged: {
    key: 'renderer.components.editor.editorLabels.stagedDiff',
    fallback: 'staged diff'
  },
  unstaged: {
    key: 'renderer.components.editor.editorLabels.diff',
    fallback: 'diff'
  },
  branch: {
    key: 'renderer.components.editor.editorLabels.branchDiff',
    fallback: 'branch diff'
  },
  commit: {
    key: 'renderer.components.editor.editorLabels.commitDiff',
    fallback: 'commit diff'
  }
}

export function getEditorDisplayLabel(
  file: OpenFile,
  variant: EditorLabelVariant = 'fileName'
): string {
  if (file.mode === 'conflict-review') {
    return translate('renderer.components.editor.editorLabels.conflictReview', 'Conflict Review')
  }

  if (file.mode === 'check-details') {
    return file.checkRunDetails?.check.name ?? getBaseLabel(file, variant)
  }

  if (file.mode === 'markdown-preview') {
    return `${getBaseLabel(file, variant)} (preview)`
  }

  if (file.mode !== 'diff') {
    return getBaseLabel(file, variant)
  }

  const source = file.diffSource
  if (source === 'combined-all') {
    return translate('renderer.components.editor.editorLabels.allChanges', 'All Changes')
  }
  if (source === 'combined-uncommitted') {
    return file.combinedAreaFilter
      ? getBaseLabel(file, variant)
      : translate(
          'renderer.components.editor.editorLabels.uncommittedChanges',
          'Uncommitted Changes'
        )
  }
  if (source === 'combined-branch') {
    return translate(
      'renderer.components.editor.editorLabels.branchChanges',
      'Branch Changes ({{baseRef}})',
      { baseRef: file.branchCompare?.baseRef ?? 'base' }
    )
  }
  if (source === 'combined-commit') {
    return file.commitCompare?.subject
      ? `Commit ${file.commitCompare.compareRef}: ${file.commitCompare.subject}`
      : `Commit ${file.commitCompare?.compareRef ?? 'diff'}`
  }

  const baseLabel = getBaseLabel(file, variant)
  const i18nConfig = source && DIFF_SOURCE_I18N_KEYS[source]
  const suffix = i18nConfig
    ? translate(i18nConfig.key, i18nConfig.fallback)
    : translate('renderer.components.editor.editorLabels.diff', 'diff')
  return `${baseLabel} (${suffix})`
}
