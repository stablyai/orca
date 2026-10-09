import { useEffect } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { hasMarkdownExtension } from './markdown-internal-links'

const DOCUMENT_WATCH_DEBOUNCE_MS = 125

function changesDocumentMembership(payload: FsChangedPayload, rootPath: string): boolean {
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(rootPath)
  ) {
    return false
  }

  return payload.events.some((event) => {
    if (event.kind === 'overflow') {
      return true
    }
    if (event.kind === 'update') {
      return false
    }
    return [event.absolutePath, event.oldAbsolutePath].some((path) => {
      if (!path) {
        return false
      }
      const relativePath = relativePathInsideRoot(rootPath, path)
      return (
        relativePath !== null && (event.isDirectory === true || hasMarkdownExtension(relativePath))
      )
    })
  })
}

export function useMarkdownDocumentWatchRefresh({
  enabled,
  worktreePath,
  runtimeEnvironmentId,
  refresh
}: {
  enabled: boolean
  worktreePath: string | null
  runtimeEnvironmentId: string | null | undefined
  refresh: (requireFresh: boolean, freshAfter: number) => Promise<void>
}): void {
  const owner = runtimeEnvironmentId?.trim() || null

  useEffect(() => {
    if (!enabled || !worktreePath) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const handleChange = (event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]): void => {
      const { payload, runtimeEnvironmentId: eventOwner } = event.detail
      if (eventOwner !== owner || !changesDocumentMembership(payload, worktreePath)) {
        return
      }
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      const changedAt = performance.now()
      // Each pane can join a scan begun after this burst, while bypassing an older snapshot.
      timer = setTimeout(() => {
        timer = undefined
        void refresh(false, changedAt)
      }, DOCUMENT_WATCH_DEBOUNCE_MS)
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleChange)
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleChange)
    }
  }, [enabled, owner, worktreePath, refresh])
}
