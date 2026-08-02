import type { GitDiffResult } from '../../../../shared/types'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'

export function shouldPruneLargeDiffContent(
  renderLimit: LargeDiffRenderLimit | null | undefined
): boolean {
  return renderLimit?.limited === true
}

export function getStoredTextDiffResult(
  result: GitDiffResult,
  renderLimit: LargeDiffRenderLimit | null | undefined
): GitDiffResult {
  if (result.kind !== 'text' || !shouldPruneLargeDiffContent(renderLimit)) {
    return result
  }

  // Why: after the fallback has enough metadata, retaining multi-MB bodies in
  // section/view caches recreates the memory pressure the fallback avoids.
  return {
    ...result,
    originalContent: '',
    modifiedContent: ''
  }
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
