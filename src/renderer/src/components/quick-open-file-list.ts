/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: quick-open file lists are fetched over local or SSH runtime IPC, so loading/error/results track the request lifecycle. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Worktree } from '../../../shared/types'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { cancelRuntimeFileList, listRuntimeFiles } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { useWorktreesForRepo } from '@/store/selectors'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'
import {
  getFileExplorerOperationOwnerFromState,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from '@/components/right-sidebar/file-explorer-operation-owner'

export type RuntimeFileListState = {
  files: string[]
  loading: boolean
  loadError: string | null
  operationOwner?: FileExplorerOperationOwner
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

export type RuntimeFileListTarget = {
  canList: boolean
  excludeRequest: NestedWorktreeExcludeRequest
  worktreePath: string | null
}

export function getRuntimeFileListTarget(
  worktreeId: string | null,
  worktreePath: string | null | undefined,
  repoWorktrees: readonly Worktree[]
): RuntimeFileListTarget {
  const resolvedWorktreePath = worktreePath ?? null
  if (!worktreeId || !resolvedWorktreePath) {
    return { canList: false, excludeRequest: { paths: [], key: '[]' }, worktreePath: null }
  }
  return {
    canList: true,
    excludeRequest: getNestedWorktreeExcludeRequest(
      worktreeId,
      resolvedWorktreePath,
      repoWorktrees
    ),
    worktreePath: resolvedWorktreePath
  }
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
  const worktree = useAppStore((state) =>
    // Why: folder workspaces live behind getKnownWorktreeById, not worktreesByRepo.
    worktreeId ? (state.getKnownWorktreeById(worktreeId) ?? null) : null
  )
  const worktreePath = worktree?.path ?? null
  const repoWorktrees = useWorktreesForRepo(worktree?.repoId ?? null)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [listedOperationOwner, setListedOperationOwner] = useState<FileExplorerOperationOwner>({
    kind: 'unresolved'
  })
  const lastRequestKeyRef = useRef('')

  const target = useMemo(
    () => getRuntimeFileListTarget(worktreeId, worktreePath, repoWorktrees),
    [repoWorktrees, worktreeId, worktreePath]
  )
  const { excludeRequest } = target

  const operationOwnerState = useAppStore(
    useShallow((state) => ({
      settings: state.settings,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
    }))
  )
  const operationOwner = useMemo(
    () => getFileExplorerOperationOwnerFromState(operationOwnerState, worktreeId),
    [operationOwnerState, worktreeId]
  )
  const operationOwnerKey = JSON.stringify(operationOwner)
  const operationOwnerRef = useRef(operationOwner)
  operationOwnerRef.current = operationOwner
  const operationRoute = getFileExplorerOperationRoute(operationOwner)
  const operationRouteAvailable = operationRoute !== null
  const connectionId = operationRoute?.connectionId
  const runtimeEnvironmentId = operationRoute?.settings.activeRuntimeEnvironmentId ?? null
  const activeTargetStatus = useAppStore((state) =>
    connectionId ? state.sshConnectionStates.get(connectionId)?.status : undefined
  )
  const connectionPending =
    activeTargetStatus === 'connecting' ||
    activeTargetStatus === 'deploying-relay' ||
    activeTargetStatus === 'reconnecting'
  const requestKey = useMemo(
    () =>
      `${worktreePath ?? ''}\n${operationOwnerKey}\n${excludeRequest.key}\n${activeTargetStatus ?? ''}`,
    [activeTargetStatus, excludeRequest.key, operationOwnerKey, worktreePath]
  )

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setListedOperationOwner({ kind: 'unresolved' })
      return
    }

    if (!target.canList || !worktreeId || !worktreePath || !operationRouteAvailable) {
      setFiles([])
      setListedOperationOwner({ kind: 'unresolved' })
      setLoadError(operationRouteAvailable ? null : getFileExplorerOwnerUnresolvedMessage())
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
    const requestToken = createBrowserUuid()
    const requestOperationOwner = operationOwnerRef.current
    const requestContext = {
      settings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
      worktreeId,
      worktreePath,
      connectionId
    }

    void listRuntimeFiles(requestContext, {
      rootPath: worktreePath,
      excludePaths,
      requestToken
    })
      .then((result) => {
        if (!cancelled) {
          setFiles(result)
          setListedOperationOwner(requestOperationOwner)
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
      // Why #7721: switching workspaces (or closing the palette) must abort
      // the previous full-tree scan host- and relay-side. Over SSH, abandoned
      // scans otherwise stack up and starve fs.readDir/fs.stat past their
      // 30s timeout ("Could not load files for this workspace").
      cancelRuntimeFileList(requestContext, requestToken)
    }
  }, [
    enabled,
    excludeRequest,
    connectionId,
    operationOwnerKey,
    operationRouteAvailable,
    requestKey,
    runtimeEnvironmentId,
    target.canList,
    worktreeId,
    worktreePath
  ])

  return {
    files,
    loading: loading || connectionPending,
    loadError,
    operationOwner: listedOperationOwner
  }
}
