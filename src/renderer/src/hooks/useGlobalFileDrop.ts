import { useEffect } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'

export function useGlobalFileDrop(): void {
  useEffect(() => {
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== 'editor') {
        return
      }

      const store = useAppStore.getState()
      const activeWorktreeId = store.activeWorktreeId
      if (!activeWorktreeId) {
        return
      }

      const activeWorktree = store.allWorktrees().find((w) => w.id === activeWorktreeId)
      const worktreePath = activeWorktree?.path

      // Why: the relay payload now sends all paths in one gesture-scoped event.
      // Loop over every dropped file so multi-file editor drops still open
      // each file, matching the prior per-path behavior.
      for (const filePath of data.paths) {
        void (async () => {
          try {
            const connectionId = getConnectionId(activeWorktreeId) ?? undefined
            // Why: remote paths don't need local auth — the relay is the security boundary.
            if (!connectionId) {
              await window.api.fs.authorizeExternalPath({ targetPath: filePath })
            }
            const stat = await window.api.fs.stat({ filePath, connectionId })
            if (stat.isDirectory) {
              return
            }

            let relativePath = filePath
            if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
              const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
              if (maybeRelative !== null && maybeRelative.length > 0) {
                relativePath = maybeRelative
              }
            }

            // Why: the preload bridge already proved this OS drop landed on the
            // tab-strip editor target. Keeping the editor-open path centralized
            // here avoids the regression where CLI drops were all coerced into
            // editor tabs once the renderer lost the original drop surface.
            store.setActiveTabType('editor')
            store.openFile({
              filePath,
              relativePath,
              worktreeId: activeWorktreeId,
              language: detectLanguage(filePath),
              mode: 'edit'
            })
          } catch {
            // Ignore files that cannot be authorized or stat'd.
          }
        })()
      }
    })
  }, [])
}
