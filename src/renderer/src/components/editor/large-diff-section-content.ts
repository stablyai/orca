import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'

export function shouldPruneLargeDiffContent(
  renderLimit: LargeDiffRenderLimit | null | undefined
): boolean {
  return renderLimit?.limited === true
}

const prunedTextDiffResults = new WeakSet<GitDiffResult>()

/** Whether this stored result dropped its bodies, so its '' is not the file's text. */
export function isPrunedTextDiffResult(result: GitDiffResult): boolean {
  return prunedTextDiffResults.has(result)
}

export function getStoredTextDiffResult(
  result: GitDiffResult,
  renderLimit: LargeDiffRenderLimit | null | undefined
): GitDiffResult {
  if (result.kind !== 'text' || !shouldPruneLargeDiffContent(renderLimit)) {
    return result
  }

  // Drop multi-MB bodies before caching or fallback viewers recreate the memory pressure they avoid.
  const pruned: GitDiffResult = { ...result, originalContent: '', modifiedContent: '' }
  prunedTextDiffResults.add(pruned)
  return pruned
}

export function getStoredTextDiffContent(
  result: GitDiffResult,
  renderLimit: LargeDiffRenderLimit | null | undefined
): { originalContent: string; modifiedContent: string } {
  if (result.kind !== 'text' || shouldPruneLargeDiffContent(renderLimit)) {
    return { originalContent: '', modifiedContent: '' }
  }

  return {
    originalContent: result.originalContent,
    modifiedContent: result.modifiedContent
  }
}
