import { detectLanguage } from '@/lib/language-detect'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'

export function cancelRevealFrame(frameRef: React.RefObject<number | null>): void {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }
}

export function openMatchResult(params: {
  activeWorktreeId: string
  runtimeEnvironmentId: string | null
  fileResult: SearchFileResult
  match: SearchMatch
  openFile: (
    file: {
      filePath: string
      relativePath: string
      worktreeId: string
      runtimeEnvironmentId?: string
      language: string
      mode: 'edit'
    },
    options?: { suppressActiveRuntimeFallback?: boolean }
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
    activeWorktreeId,
    runtimeEnvironmentId,
    fileResult,
    match,
    openFile,
    setPendingEditorReveal,
    revealRafRef,
    revealInnerRafRef
  } = params

  openFile(
    {
      filePath: fileResult.filePath,
      relativePath: fileResult.relativePath,
      worktreeId: activeWorktreeId,
      runtimeEnvironmentId: runtimeEnvironmentId ?? undefined,
      language: detectLanguage(fileResult.relativePath),
      mode: 'edit'
    },
    {
      // Why: search results come from the worktree's owning runtime; opening
      // them must keep that owner (or pin local) instead of letting the ambient
      // active-runtime fallback pick a host that cannot read the path (#9185).
      suppressActiveRuntimeFallback: runtimeEnvironmentId === null
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
