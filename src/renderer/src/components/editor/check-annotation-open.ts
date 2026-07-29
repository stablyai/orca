import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getOpenableAnnotationLine,
  resolveAnnotationPathInsideWorktree
} from './check-annotation-path'

export { getOpenableAnnotationLine }

export function openAnnotationLocation(params: {
  worktreeId: string
  path: string
  line: number
  revealRafRef: React.RefObject<number | null>
  revealInnerRafRef: React.RefObject<number | null>
}): void {
  const { worktreeId, path, line, revealRafRef, revealInnerRafRef } = params
  const store = useAppStore.getState()
  const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
  if (!worktree) {
    return
  }
  const resolvedPath = resolveAnnotationPathInsideWorktree(worktree.path, path)
  if (!resolvedPath) {
    return
  }
  const { absolutePath, relativePath } = resolvedPath

  // Why: reuse the shared activation path so an annotation jump lands in the
  // same history stack as sidebar, palette, and terminal-link navigation.
  activateAndRevealWorktree(worktreeId)

  store.openFile(
    {
      filePath: absolutePath,
      relativePath,
      worktreeId,
      language: detectLanguage(relativePath),
      mode: 'edit'
    },
    { forceContentReload: true }
  )

  cancelAnnotationRevealFrame(revealRafRef)
  cancelAnnotationRevealFrame(revealInnerRafRef)
  store.setPendingEditorReveal(null)

  // Why: opening can replace the active tab and mount Monaco asynchronously.
  // Matching search and terminal-link navigation, wait two frames so the
  // destination editor owns layout before we ask it to reveal the line.
  revealRafRef.current = requestAnimationFrame(() => {
    revealInnerRafRef.current = requestAnimationFrame(() => {
      store.setPendingEditorReveal({ filePath: absolutePath, line, column: 1, matchLength: 0 })
      cancelAnnotationRevealFrame(revealRafRef)
      cancelAnnotationRevealFrame(revealInnerRafRef)
    })
  })
}

export function cancelAnnotationRevealFrame(frameRef: React.RefObject<number | null>): void {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }
}
