import { useEffect } from 'react'
import { toast } from 'sonner'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import {
  importExternalPathsToRuntime,
  isRemoteRuntimeFileOperation,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import type { GlobalSettings } from '../../../shared/types'

export function shouldUploadRemoteEditorFileDrop(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | null | undefined
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim() || connectionId?.trim())
}

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
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      const dropSettings = store.settings
      const runtimeEnvironmentId = dropSettings?.activeRuntimeEnvironmentId?.trim() || undefined
      if (shouldUploadRemoteEditorFileDrop(dropSettings, connectionId)) {
        if (!worktreePath) {
          toast.error('No remote workspace path is available for dropped files.')
          return
        }
        void (async () => {
          try {
            // Why: OS file drops provide client-local paths. Remote runtime and
            // SSH editors must upload into the server worktree before opening.
            const destinationDir = joinPath(worktreePath, '.orca/drops')
            const { results } = await importExternalPathsToRuntime(
              {
                settings: dropSettings,
                worktreeId: activeWorktreeId,
                worktreePath,
                connectionId
              },
              data.paths,
              destinationDir,
              { ensureDestinationDir: true }
            )
            const imported = results.filter((result) => result.status === 'imported')
            for (const result of imported) {
              if (result.kind === 'directory') {
                continue
              }
              const maybeRelative = toWorktreeRelativePath(result.destPath, worktreePath)
              store.setActiveTabType('editor')
              store.openFile(
                {
                  filePath: result.destPath,
                  relativePath: maybeRelative ?? result.destPath,
                  worktreeId: activeWorktreeId,
                  runtimeEnvironmentId,
                  language: detectLanguage(result.destPath),
                  mode: 'edit'
                },
                { suppressActiveRuntimeFallback: runtimeEnvironmentId === undefined }
              )
            }
            if (results.some((result) => result.status !== 'imported')) {
              toast.error('Some dropped files could not be uploaded.')
            }
          } catch {
            toast.error('Failed to upload dropped files.')
          }
        })()
        return
      }

      // Why: the relay payload now sends all paths in one gesture-scoped event.
      // Loop over every dropped file so multi-file editor drops still open
      // each file, matching the prior per-path behavior.
      for (const filePath of data.paths) {
        void (async () => {
          try {
            const fileContext: RuntimeFileOperationArgs = {
              settings: store.settings,
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId
            }
            const isRemoteRuntimePath = isRemoteRuntimeFileOperation(fileContext, filePath)
            // Why: remote paths don't need local auth — the relay/runtime is the security boundary.
            if (!connectionId && !isRemoteRuntimePath) {
              await window.api.fs.authorizeExternalPath({ targetPath: filePath })
            }
            const stat = await statRuntimePath(fileContext, filePath)
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
