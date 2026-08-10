import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'
import { formatFileCompareTabLabel } from '@/lib/file-explorer-file-compare'

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

const DIFF_SOURCE_LABELS: Record<string, string> = {
  staged: 'staged diff',
  unstaged: 'diff',
  branch: 'branch diff',
  commit: 'commit diff'
}

export function getEditorDisplayLabel(
  file: OpenFile,
  variant: EditorLabelVariant = 'fileName'
): string {
  if (file.mode === 'conflict-review') {
    return 'Conflict Review'
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
    return 'All Changes'
  }
  if (source === 'combined-uncommitted') {
    return file.combinedAreaFilter ? getBaseLabel(file, variant) : 'Uncommitted Changes'
  }
  if (source === 'combined-branch') {
    return `Branch Changes (${file.branchCompare?.baseRef ?? 'base'})`
  }
  if (source === 'combined-commit') {
    return file.commitCompare?.subject
      ? `Commit ${file.commitCompare.compareRef}: ${file.commitCompare.subject}`
      : `Commit ${file.commitCompare?.compareRef ?? 'diff'}`
  }
  if (source === 'file-compare' && file.compareTarget) {
    return formatFileCompareTabLabel(file.relativePath, file.compareTarget.relativePath)
  }

  const baseLabel = getBaseLabel(file, variant)
  const suffix = (source && DIFF_SOURCE_LABELS[source]) ?? 'diff'
  return `${baseLabel} (${suffix})`
}
