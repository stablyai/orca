import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

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

function getDiffTabLabel(
  name: string,
  source: OpenFile['diffSource'],
  t: Translate = translate
): string {
  if (source === 'staged') {
    return t('auto.components.editor.editorLabels.stagedDiff', '{{name}} (staged diff)', {
      name
    })
  }
  if (source === 'branch') {
    return t('auto.components.editor.editorLabels.branchDiff', '{{name}} (branch diff)', {
      name
    })
  }
  if (source === 'commit') {
    return t('auto.components.editor.editorLabels.commitDiff', '{{name}} (commit diff)', {
      name
    })
  }
  return t('auto.components.editor.editorLabels.diff', '{{name}} (diff)', { name })
}

export function getEditorDisplayLabel(
  file: OpenFile,
  variant: EditorLabelVariant = 'fileName',
  t: Translate = translate
): string {
  if (file.mode === 'conflict-review') {
    return t('auto.components.editor.editorLabels.conflictReview', 'Conflict Review')
  }

  if (file.mode === 'git-graph') {
    return t('gitGraph.title', 'Git Graph')
  }
  if (file.mode === 'check-details') {
    return file.checkRunDetails?.check.name ?? getBaseLabel(file, variant)
  }

  if (file.mode === 'markdown-preview') {
    return t('auto.components.editor.editorLabels.preview', '{{name}} (preview)', {
      name: getBaseLabel(file, variant)
    })
  }

  if (file.mode !== 'diff') {
    return getBaseLabel(file, variant)
  }

  const source = file.diffSource
  if (source === 'combined-all') {
    return t('auto.components.editor.editorLabels.allChanges', 'All Changes')
  }
  if (source === 'combined-uncommitted') {
    return file.combinedAreaFilter
      ? getBaseLabel(file, variant)
      : t('auto.components.editor.editorLabels.uncommittedChanges', 'Uncommitted Changes')
  }
  if (source === 'combined-branch') {
    return file.branchCompare?.baseRef
      ? t('auto.components.editor.editorLabels.branchChanges', 'Branch Changes ({{baseRef}})', {
          baseRef: file.branchCompare.baseRef
        })
      : t('auto.components.editor.editorLabels.branchChangesBase', 'Branch Changes (base)')
  }
  if (source === 'combined-commit') {
    if (file.commitCompare?.subject) {
      return t(
        'auto.components.editor.editorLabels.commitWithSubject',
        'Commit {{ref}}: {{subject}}',
        { ref: file.commitCompare.compareRef, subject: file.commitCompare.subject }
      )
    }
    return file.commitCompare?.compareRef
      ? t('auto.components.editor.editorLabels.commit', 'Commit {{ref}}', {
          ref: file.commitCompare.compareRef
        })
      : t('auto.components.editor.editorLabels.commitDiffFallback', 'Commit diff')
  }

  return getDiffTabLabel(getBaseLabel(file, variant), source, t)
}
