/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: quick-open file lists are fetched over local or SSH runtime IPC, so loading/error/results track the request lifecycle. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Worktree } from '../../../shared/types'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { getConnectionId } from '@/lib/connection-context'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
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
  const windowsPath = isWindowsAbsolutePathLike(parentPath)
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

export type NestedWorktreeExcludeRequest = {
  paths: string[]
  key: string
}

export function getNestedWorktreeExcludeRequest(
  worktreeId: string | null,
  worktreePath: string | null,
  repoWorktrees: readonly Worktree[]
): NestedWorktreeExcludeRequest {
  if (!worktreeId || !worktreePath || repoWorktrees.length === 0) {
    return { paths: [], key: '[]' }
  }
  const paths = getNestedWorktreeExcludePaths(worktreeId, worktreePath, repoWorktrees)
  // Why: worktree paths can contain newlines. Use JSON as a stable dependency
  // key while passing the original array to IPC so paths stay lossless.
  return { paths, key: JSON.stringify(paths) }
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
  const excludeRequest = useMemo(
    () => getNestedWorktreeExcludeRequest(worktreeId, worktreePath, repoWorktrees),
    [repoWorktrees, worktreeId, worktreePath]
  )

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
      `${worktreePath ?? ''}\n${connectionId ?? ''}\n${excludeRequest.key}\n${activeTargetStatus ?? ''}`,
    [activeTargetStatus, connectionId, excludeRequest.key, worktreePath]
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

    const excludePaths = excludeRequest.paths.length > 0 ? excludeRequest.paths : undefined

    void listRuntimeFiles(
      {
        // Why: Quick Open lists files for the selected workspace. It must
        // follow that workspace's owner host, not the globally focused host.
        settings: getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId),
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
  }, [connectionId, enabled, excludeRequest, requestKey, worktreeId, worktreePath])

  return { files, loading: loading || connectionPending, loadError }
}
