import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { diffReviewKey, diffReviewScope } from '@/lib/editor/diff-reviewed-files'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { acquireCombinedDiffSectionOperation } from '../load-sections/combined-diff-section-connection'

export function combinedDiffReviewIdentity(
  file: OpenFile,
  section: Pick<DiffSection, 'path' | 'area'>
) {
  const operation = acquireCombinedDiffSectionOperation(file, section.path)
  const diffSource =
    section.area !== undefined
      ? section.area === 'staged'
        ? 'staged'
        : 'unstaged'
      : file.diffSource === 'combined-commit'
        ? 'commit'
        : 'branch'
  return {
    operation,
    key: diffReviewKey(operation.context, section.path, diffReviewScope({ ...file, diffSource }))
  }
}
