import { useEffect, useMemo, useRef, useState } from 'react'
import type { Worktree } from '../../../shared/types'
import { getConnectionId } from '@/lib/connection-context'
import { listRuntimeFiles } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { useWorktreeById, useWorktreesForRepo } from '@/store/selectors'

export type RuntimeFileListState = {
  files: string[]
  loading: boolean
  loadError: string | null
}

export function cleanRuntimeFileListError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
}

export function isNestedWorktreePath(parentPath: string, childPath: string): boolean {
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(parentPath) || parentPath.startsWith('\\\\')
  const parent = parentPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const child = childPath.replace(/\\/g, '/')
  // Why: Windows paths are case-insensitive and can arrive with mixed slash
  // styles from git/Electron. Normalize before deciding whether to exclude a
  // nested linked worktree from file scans.
  const comparableParent = windowsPath ? parent.toLowerCase() : parent
  const comparableChild = windowsPath ? child.toLowerCase() : child
  return comparableChild.startsWith(`${comparableParent}/`)
}

export function getNestedWorktreeExcludePaths(
  worktreeId: string,
  worktreePath: string,
  repoWorktrees: readonly Worktree[]
): string[] {
  return repoWorktrees
    .filter(
      (worktree) => worktree.id !== worktreeId && isNestedWorktreePath(worktreePath, worktree.path)
    )
    .map((worktree) => worktree.path)
    .sort()
}

export function useRuntimeFileListForWorktree({
  enabled,
  worktreeId
}: {
  enabled: boolean
  worktreeId: string | null
}): RuntimeFileListState {
  const worktree = useWorktreeById(worktreeId)
  const repoWorktrees = useWorktreesForRepo(worktree?.repoId ?? null)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const lastRequestKeyRef = useRef('')

  const worktreePath = worktree?.path ?? null
  const excludePathsKey = useMemo(() => {
    if (!worktreeId || !worktreePath || repoWorktrees.length === 0) {
      return ''
    }
    return getNestedWorktreeExcludePaths(worktreeId, worktreePath, repoWorktrees).join('\n')
  }, [repoWorktrees, worktreeId, worktreePath])

  const connectionId = useMemo(() => getConnectionId(worktreeId) ?? undefined, [worktreeId])
  const activeTargetStatus = useAppStore((state) =>
    connectionId ? state.sshConnectionStates.get(connectionId)?.status : undefined
  )
  const connectionPending =
    activeTargetStatus === 'connecting' ||
    activeTargetStatus === 'deploying-relay' ||
    activeTargetStatus === 'reconnecting'
  const requestKey = useMemo(
    () =>
      `${worktreePath ?? ''}\n${connectionId ?? ''}\n${excludePathsKey}\n${activeTargetStatus ?? ''}`,
    [activeTargetStatus, connectionId, excludePathsKey, worktreePath]
  )

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    if (!worktreeId || !worktreePath) {
      setFiles([])
      setLoadError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    const requestKeyChanged = lastRequestKeyRef.current !== requestKey
    if (requestKeyChanged) {
      setFiles([])
    }
    lastRequestKeyRef.current = requestKey
    setLoadError(null)
    setLoading(true)

    const excludePaths = excludePathsKey ? excludePathsKey.split('\n') : undefined

    void listRuntimeFiles(
      {
        settings: useAppStore.getState().settings,
        worktreeId,
        worktreePath,
        connectionId
      },
      {
        rootPath: worktreePath,
        excludePaths
      }
    )
      .then((result) => {
        if (!cancelled) {
          setFiles(result)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFiles([])
          setLoadError(cleanRuntimeFileListError(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [connectionId, enabled, excludePathsKey, requestKey, worktreeId, worktreePath])

  return { files, loading: loading || connectionPending, loadError }
}
