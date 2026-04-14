import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'

type UseFileExplorerImportParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  refreshDir: (dirPath: string) => Promise<void>
  clearNativeDragState: () => void
}

/**
 * Subscribes to native file-drop events targeted at the file explorer and
 * runs the import pipeline: copy into worktree, refresh, reveal.
 *
 * Why this is a separate hook: the actual filesystem paths from native OS
 * drops are only available through the preload-relayed IPC event, not the
 * React drop handler. The drop handler manages visual state; this hook
 * manages the import action.
 */
export function useFileExplorerImport({
  worktreePath,
  activeWorktreeId,
  refreshDir,
  clearNativeDragState
}: UseFileExplorerImportParams): void {
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)

  // Refs to avoid re-subscribing IPC listener on every render
  const worktreePathRef = useRef(worktreePath)
  worktreePathRef.current = worktreePath
  const activeWorktreeIdRef = useRef(activeWorktreeId)
  activeWorktreeIdRef.current = activeWorktreeId
  const refreshDirRef = useRef(refreshDir)
  refreshDirRef.current = refreshDir
  const clearNativeDragStateRef = useRef(clearNativeDragState)
  clearNativeDragStateRef.current = clearNativeDragState
  const revealInExplorerRef = useRef(revealInExplorer)
  revealInExplorerRef.current = revealInExplorer

  useEffect(() => {
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== 'file-explorer') {
        return
      }

      const wtId = activeWorktreeIdRef.current
      if (!wtId || !worktreePathRef.current) {
        // Why: the preload stops propagation of the native drop event, so
        // React onDrop handlers never fire. We must clear the drag highlight
        // ourselves even when we bail out, otherwise the explorer stays stuck
        // in its drag-over visual state.
        clearNativeDragStateRef.current()
        return
      }

      const { paths, destinationDir } = data

      void (async () => {
        try {
          const { results } = await window.api.fs.importExternalPaths({
            sourcePaths: paths,
            destDir: destinationDir
          })

          // Refresh the destination directory once per gesture
          await refreshDirRef.current(destinationDir)

          // Reveal and flash the first successfully imported path
          const imported = results.filter((r) => r.status === 'imported')
          if (imported.length > 0) {
            revealInExplorerRef.current(wtId, imported[0].destPath)
          }
        } finally {
          clearNativeDragStateRef.current()
        }
      })()
    })
  }, [])
}
