import { detectLanguage } from '@/lib/language-detect'
import type { FileSearchResultOwner } from '@/lib/file-search-result-owner'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'

export function cancelRevealFrame(frameRef: React.RefObject<number | null>): void {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }
}

export function openMatchResult(params: {
  resultOwner: FileSearchResultOwner | null
  fileResult: SearchFileResult
  match: SearchMatch
  openFile: (
    file: {
      filePath: string
      relativePath: string
      worktreeId: string
      language: string
      mode: 'edit'
      runtimeEnvironmentId: string | null
    },
    options: { suppressActiveRuntimeFallback: boolean }
  ) => void
  setPendingEditorReveal: (
    reveal: {
      filePath: string
      line: number
      column: number
      matchLength: number
    } | null
  ) => void
  revealRafRef: React.RefObject<number | null>
  revealInnerRafRef: React.RefObject<number | null>
}): void {
  const {
    resultOwner,
    fileResult,
    match,
    openFile,
    setPendingEditorReveal,
    revealRafRef,
    revealInnerRafRef
  } = params

  if (!resultOwner) {
    return
  }

  openFile(
    {
      filePath: fileResult.filePath,
      relativePath: fileResult.relativePath,
      worktreeId: resultOwner.worktreeId,
      runtimeEnvironmentId: resultOwner.runtimeEnvironmentId,
      language: detectLanguage(fileResult.relativePath),
      mode: 'edit'
    },
    {
      suppressActiveRuntimeFallback: resultOwner.runtimeEnvironmentId === null
    }
  )

  cancelRevealFrame(revealRafRef)
  cancelRevealFrame(revealInnerRafRef)
  setPendingEditorReveal(null)

  // Why: opening a result can replace the active tab and mount Monaco
  // asynchronously. Matching terminal-link navigation, wait two frames so
  // the destination editor owns focus/layout before we ask it to reveal.
  revealRafRef.current = requestAnimationFrame(() => {
    revealInnerRafRef.current = requestAnimationFrame(() => {
      setPendingEditorReveal({
        filePath: fileResult.filePath,
        line: match.line,
        column: match.column,
        matchLength: match.matchLength
      })
      cancelRevealFrame(revealRafRef)
      cancelRevealFrame(revealInnerRafRef)
    })
  })
}
