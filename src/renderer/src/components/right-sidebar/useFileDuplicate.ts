import { useCallback } from 'react'
import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import type { TreeNode } from './file-explorer-types'

/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 */
function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type UseFileDuplicateParams = {
  worktreePath: string | null
  refreshDir: (dirPath: string) => Promise<void>
}

export function useFileDuplicate({
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
        // Why: generate a unique "stem copy.ext", "stem copy 2.ext", … name
        // so we never collide with an existing file. pathExists checks are
        // sequential to avoid TOCTOU races with COPYFILE_EXCL on the backend.
        let candidate = joinPath(dir, `${stem} copy${ext}`)
        let n = 2
        while (await window.api.shell.pathExists(candidate)) {
          candidate = joinPath(dir, `${stem} copy ${n}${ext}`)
          n += 1
        }

        // Why: Between the final pathExists returning false and the copyFile
        // call, another process could create a file at that path (TOCTOU race).
        // The backend uses COPYFILE_EXCL which will fail with EEXIST in that
        // case. Instead of surfacing a generic error toast, we retry with the
        // next candidate name. A max-retry limit of 10 prevents infinite loops
        // in degenerate scenarios.
        const MAX_RETRIES = 10
        let retries = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            await window.api.shell.copyFile({ srcPath: node.path, destPath: candidate })
            break
          } catch (err) {
            const isEexist =
              err instanceof Error &&
              (err.message.includes('EEXIST') || err.message.includes('already exists'))
            if (isEexist && retries < MAX_RETRIES) {
              // The candidate was taken between our check and the copy attempt;
              // advance to the next name and retry.
              candidate = joinPath(dir, `${stem} copy ${n}${ext}`)
              n += 1
              retries += 1
              continue
            }
            toast.error(extractIpcErrorMessage(err, `Failed to duplicate '${name}'.`))
            return
          }
        }

        // Best-effort refresh; the file was already copied successfully,
        // so a refresh failure should not surface an error to the user.
        try {
          await refreshDir(dir)
        } catch {
          // noop – the copy succeeded; stale tree is a minor inconvenience.
        }
      }
      void run()
    },
    [worktreePath, refreshDir]
  )
}
