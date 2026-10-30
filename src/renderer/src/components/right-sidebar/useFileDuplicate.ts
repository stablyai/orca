import { useCallback } from 'react'
import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import type { TreeNode } from './file-explorer-types'
import { copyRuntimePath } from '@/runtime/runtime-file-mutation-client'
import { runtimePathExists } from '@/runtime/runtime-file-metadata-client'
import { captureFileExplorerOperationGuard } from './file-explorer-operation-owner'

/** Strip Electron invoke error wrappers before showing the underlying message. */
function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type UseFileDuplicateParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  refreshDir: (dirPath: string) => Promise<void>
}

export function useFileDuplicate({
  activeWorktreeId,
  worktreePath,
  refreshDir
}: UseFileDuplicateParams): (node: TreeNode) => void {
  return useCallback(
    (node: TreeNode) => {
      if (node.isDirectory || !worktreePath) {
        return
      }
      const dir = dirname(node.path)
      const name = basename(node.path)
      const dotIndex = name.lastIndexOf('.')
      const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name
      const ext = dotIndex > 0 ? name.slice(dotIndex) : ''

      const run = async (): Promise<void> => {
        let operationGuard
        try {
          operationGuard = captureFileExplorerOperationGuard(activeWorktreeId, node.operationOwner)
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, `Failed to duplicate '${name}'.`))
          return
        }
        const context = {
          target: operationGuard.route.target,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: operationGuard.route.connectionId,
          expectedExecutionHostId: operationGuard.route.expectedExecutionHostId,
          expectedSshTargetId: operationGuard.route.expectedSshTargetId,
          expectedSshConnectionGeneration: operationGuard.route.expectedSshConnectionGeneration
        }
        // Find an available copy name; the exclusive copy below handles concurrent creation races.
        let candidate = joinPath(dir, `${stem} copy${ext}`)
        let n = 2
        while (await runtimePathExists(context, candidate)) {
          candidate = joinPath(dir, `${stem} copy ${n}${ext}`)
          n += 1
        }

        // Another process can claim the name after pathExists; retry exclusive-copy EEXIST failures with a bounded new-name search.
        const MAX_RETRIES = 10
        let retries = 0
        while (true) {
          try {
            operationGuard.assertCurrent()
            await copyRuntimePath(context, node.path, candidate)
            break
          } catch (err) {
            const isEexist =
              err instanceof Error &&
              (err.message.includes('EEXIST') || err.message.includes('already exists'))
            if (isEexist && retries < MAX_RETRIES) {
              candidate = joinPath(dir, `${stem} copy ${n}${ext}`)
              n += 1
              retries += 1
              continue
            }
            toast.error(extractIpcErrorMessage(err, `Failed to duplicate '${name}'.`))
            return
          }
        }

        // Refresh failures must not report an already-successful copy as failed.
        try {
          await refreshDir(dir)
        } catch {}
      }
      void run()
    },
    [activeWorktreeId, worktreePath, refreshDir]
  )
}
