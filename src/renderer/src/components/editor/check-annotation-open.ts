import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getOpenableAnnotationLine,
  resolveAnnotationPathInsideWorktree
} from './check-annotation-path'
import { registerWorkspaceSurfaceProducer } from '@/lib/workspace-surface-production'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

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
  cancelAnnotationRevealFrame(revealRafRef)
  cancelAnnotationRevealFrame(revealInnerRafRef)

  // Why: reuse the shared activation path so an annotation jump lands in the
  // same history stack as sidebar, palette, and terminal-link navigation.
  const producer = registerWorkspaceSurfaceProducer({
    workspaceKey: worktreeId,
    executionHostId: getExecutionHostIdForWorktree(store, worktreeId)
  })
  try {
    const activation = activateAndRevealWorktree(worktreeId)
    if (activation === false) {
      producer.failed('The workspace is no longer available.')
      return
    }
    const surfaceId = store.openFile(
      {
        filePath: absolutePath,
        relativePath,
        worktreeId,
        language: detectLanguage(relativePath),
        mode: 'edit'
      },
      { forceContentReload: true }
    )
    producer.materialized({ kind: 'tab', id: surfaceId })
  } catch (error) {
    producer.failed(error)
    return
  }
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
