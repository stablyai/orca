import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  readRuntimeFileContent,
  subscribeRuntimeFileChanges,
  type RuntimeReadableFileContent
} from '@/runtime/runtime-file-client'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  getFileExplorerOperationOwnerFromState,
  requireMatchingFileExplorerOperationRoute
} from '../right-sidebar/file-explorer-operation-owner'
import type { FloatingFileViewer } from './floating-file-viewer-state'

export function useFloatingFileContent(viewer: FloatingFileViewer, visible: boolean) {
  const [content, setContent] = useState<RuntimeReadableFileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const currentOwner = useAppStore((state) =>
    JSON.stringify(getFileExplorerOperationOwnerFromState(state, viewer.worktreeId))
  )
  const { id, worktreeId, worktreePath, filePath, relativePath, owner } = viewer
  useEffect(() => {
    if (!visible) {
      return
    }
    let disposed = false
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    const report = (err: unknown) => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    const read = async () => {
      const request = ++generation
      try {
        const route = requireMatchingFileExplorerOperationRoute(worktreeId, owner)
        const result = await readRuntimeFileContent({
          ...route,
          filePath,
          relativePath,
          worktreeId
        })
        if (!disposed && request === generation) {
          setContent(result)
          setError(null)
        }
      } catch (err) {
        if (request === generation) {
          report(err)
        }
      }
    }
    const reload = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void read(), 150)
    }
    void read()
    try {
      const route = requireMatchingFileExplorerOperationRoute(worktreeId, owner)
      void subscribeRuntimeFileChanges(
        { ...route, worktreeId, worktreePath },
        (payload) => {
          if (
            normalizeRuntimePathForComparison(payload.worktreePath) !==
            normalizeRuntimePathForComparison(worktreePath)
          ) {
            return
          }
          if (
            payload.events.some(
              (event) =>
                event.kind === 'overflow' ||
                [event.absolutePath, event.oldAbsolutePath].some(
                  (path) =>
                    path &&
                    (normalizeRuntimePathForComparison(path) ===
                      normalizeRuntimePathForComparison(filePath) ||
                      (event.isDirectory &&
                        normalizeRuntimePathForComparison(filePath).startsWith(
                          `${normalizeRuntimePathForComparison(path)}/`
                        )))
                )
            )
          ) {
            reload()
          }
        },
        report
      )
        .then((stop) => {
          if (disposed) {
            stop()
          } else {
            unsubscribe = stop
          }
        })
        .catch(report)
    } catch (err) {
      report(err)
    }
    window.addEventListener('focus', reload)
    return () => {
      disposed = true
      clearTimeout(timer)
      unsubscribe?.()
      window.removeEventListener('focus', reload)
    }
  }, [id, worktreeId, worktreePath, filePath, relativePath, owner, currentOwner, visible, retry])
  return { content, error, reload: () => setRetry((value) => value + 1) }
}
