import type { GitDiffResult } from '../../../../../../shared/git/diff/git-diff-compare-types'
import { getDiffContentSignature } from '../sections/diff-content-signature'

export function diffReviewContentSignature(
  content: Pick<GitDiffResult, 'kind' | 'originalContent' | 'modifiedContent'>
): string {
  return JSON.stringify([
    content.kind,
    content.originalContent.length,
    getDiffContentSignature(content.originalContent),
    content.modifiedContent.length,
    getDiffContentSignature(content.modifiedContent)
  ])
}
