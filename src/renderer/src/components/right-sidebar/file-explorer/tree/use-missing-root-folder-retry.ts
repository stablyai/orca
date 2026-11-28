import { useEffect } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

const ROOT_FOLDER_POLL_MS = 3_000
const MISSING_FOLDER_ERROR = /\b(ENOENT|ENOTDIR)\b/

/** A local explorer root that failed as missing (an unmounted volume) reloads once the folder is back. */
export function useMissingRootFolderRetry({
  rootPath,
  error,
  isLocal,
  reload
}: {
  rootPath: string | null
  error: string | null
  isLocal: boolean
  reload: (rootPath: string) => void
}): void {
  const waiting = isLocal && rootPath !== null && error !== null && MISSING_FOLDER_ERROR.test(error)
  useEffect(() => {
    if (!waiting || rootPath === null) {
      return
    }
    let stopped = false
    const stopPolling = installWindowVisibilityInterval({
      intervalMs: ROOT_FOLDER_POLL_MS,
      slowWhileUnfocused: true,
      run: () => {
        void window.api.shell
          .pathExists(rootPath)
          .catch(() => false)
          .then((exists) => {
            if (exists && !stopped) {
              reload(rootPath)
            }
          })
      }
    })
    return () => {
      stopped = true
      stopPolling()
    }
  }, [waiting, rootPath, reload])
}
