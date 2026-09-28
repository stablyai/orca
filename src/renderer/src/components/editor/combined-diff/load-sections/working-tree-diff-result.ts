import type { GitDiffResult } from '../../../../../../shared/git-diff-compare-types'

/** Existing host APIs supply the merge-base side and the saved working-tree side. */
export function combineWorkingTreeDiffResult(
  base: GitDiffResult,
  working: GitDiffResult
): GitDiffResult {
  const content = {
    originalContent: base.originalContent,
    modifiedContent: working.modifiedContent
  }
  const largeDiffRenderLimit =
    base.kind === 'text' && base.largeDiffRenderLimit?.limited
      ? base.largeDiffRenderLimit
      : working.kind === 'text' && working.largeDiffRenderLimit?.limited
        ? working.largeDiffRenderLimit
        : undefined
  if (largeDiffRenderLimit) {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false,
      largeDiffRenderLimit
    }
  }
  const preview = working.kind === 'binary' ? working : base.kind === 'binary' ? base : undefined
  const binary = {
    ...content,
    kind: 'binary' as const,
    mimeType: preview?.mimeType,
    isImage: preview?.isImage,
    modifiedDeleted: working.kind === 'binary' ? working.modifiedDeleted : undefined
  }
  if (base.originalIsBinary) {
    return { ...binary, originalIsBinary: true, modifiedIsBinary: working.modifiedIsBinary }
  }
  if (working.modifiedIsBinary) {
    return { ...binary, originalIsBinary: false, modifiedIsBinary: true }
  }
  return {
    ...content,
    kind: 'text',
    originalIsBinary: false,
    modifiedIsBinary: false,
    largeDiffRenderLimit: undefined
  }
}
