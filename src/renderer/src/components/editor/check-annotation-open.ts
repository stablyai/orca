import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import {
  getOpenableAnnotationLine,
  resolveAnnotationPathInsideWorktree
} from './check-annotation-path'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export { getOpenableAnnotationLine }

export function openAnnotationLocation(params: {
  worktreeId: string
  path: string
  line: number
  executionHostId?: ExecutionHostId
}): void {
  const { worktreeId, path, line, executionHostId } = params
  const store = useAppStore.getState()
  const worktree = store.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return
  }
  const resolvedPath = resolveAnnotationPathInsideWorktree(worktree.path, path)
  if (!resolvedPath) {
    return
  }
  const { absolutePath, relativePath } = resolvedPath
  const language = detectLanguage(relativePath)

  // Why: reuse the shared activation path so an annotation jump lands in the
  // same history stack as sidebar, palette, and terminal-link navigation.
  activateAndRevealWorktree(worktreeId, { providesInitialSurface: true, executionHostId })

  const fileId = store.openFile(
    { filePath: absolutePath, relativePath, worktreeId, language, mode: 'edit' },
    { forceContentReload: true }
  )
  if (language === 'markdown') {
    store.setMarkdownViewMode(fileId, 'source')
  }
  scheduleEditorLineReveal(useAppStore.getState, absolutePath, line, 1, fileId)
}
