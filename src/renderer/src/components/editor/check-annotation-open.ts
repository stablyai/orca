import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { PRCheckAnnotation } from '../../../../shared/types'

/**
 * A CI annotation only links to the editor when its path names a real repo file
 * at a line — not a workflow-level reference like `.github` (no extension), which
 * has no on-disk location to reveal. Requiring a file extension keeps the
 * affordance honest: links that wouldn't open never render.
 */
export function getOpenableAnnotationLine(
  annotation: PRCheckAnnotation
): { path: string; line: number } | null {
  const path = annotation.path?.trim()
  if (!path || !annotation.startLine) {
    return null
  }
  const basename = path.split(/[\\/]/).pop() ?? ''
  const hasExtension = basename.lastIndexOf('.') > 0
  if (!hasExtension) {
    return null
  }
  return { path, line: annotation.startLine }
}

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
  const absolutePath = joinPath(worktree.path, path)

  // Why: reuse the shared activation path so an annotation jump lands in the
  // same history stack as sidebar, palette, and terminal-link navigation.
  activateAndRevealWorktree(worktreeId)

  store.openFile(
    {
      filePath: absolutePath,
      relativePath: path,
      worktreeId,
      language: detectLanguage(path),
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
