import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'

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
  branch: 'branch diff'
}

export function getEditorDisplayLabel(
  file: OpenFile,
  variant: EditorLabelVariant = 'fileName'
): string {
  if (file.mode === 'conflict-review') {
    return 'Conflict Review'
  }

  if (file.mode === 'markdown-preview') {
    return `${getBaseLabel(file, variant)} (preview)`
  }

  if (file.mode !== 'diff') {
    return getBaseLabel(file, variant)
  }

  const source = file.diffSource
  if (source === 'combined-uncommitted') {
    return 'All Changes'
  }
  if (source === 'combined-branch') {
    return `Branch Changes (${file.branchCompare?.baseRef ?? 'base'})`
  }

  const baseLabel = getBaseLabel(file, variant)
  const suffix = (source && DIFF_SOURCE_LABELS[source]) ?? 'diff'
  return `${baseLabel} (${suffix})`
}
