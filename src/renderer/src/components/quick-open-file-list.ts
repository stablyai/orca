/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: quick-open file lists are fetched over local or SSH runtime IPC, so loading/error/results track the request lifecycle. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Worktree } from '../../../shared/worktree/types'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { isQuickOpenRemoteQueryTooLarge } from '@/components/quick-open-search'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import {
  cancelRuntimeFileList,
  listRuntimeFiles,
  searchRuntimeFilePaths
} from '@/runtime/runtime-file-client'
import { debounceRuntimeFileRequest } from '@/runtime/runtime-file-request-debounce'
import { splitFileNameFilterTokens } from '../../../shared/file-name-filter-tokens'
import {
  nextCappedLocalListing,
  type CappedLocalListing
} from '@/components/quick-open-capped-local-listing'
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
  truncated?: boolean
  operationOwner?: FileExplorerOperationOwner
}

/** Files settled for one request key; local listings key without the query, so they answer every query. */
type RuntimeFileListing = {
  requestKey: string
  files: string[]
  truncated: boolean
}

const NO_LISTING: RuntimeFileListing = { requestKey: '', files: [], truncated: false }

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
  worktreeId,
  query,
  hostFilterWhenCapped = false
}: {
  enabled: boolean
  worktreeId: string | null
  query?: string
  /** When a local listing hits its cap, re-list with `query` applied as the Explorer name filter on the host. */
  hostFilterWhenCapped?: boolean
}): RuntimeFileListState {
  const worktree = useAppStore((state) =>
    // Why: folder workspaces live behind getKnownWorktreeById, not worktreesByRepo.
    worktreeId ? (state.getKnownWorktreeById(worktreeId) ?? null) : null
  )
  const worktreePath = worktree?.path ?? null
  const repoWorktrees = useWorktreesForRepo(worktree?.repoId ?? null)
  const [listing, setListing] = useState(NO_LISTING)
  const [loadingRequest, setLoadingRequest] = useState({ requestKey: '', loading: false })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cappedLocalListing, setCappedLocalListing] = useState<CappedLocalListing | null>(null)
  const [listedOperationOwner, setListedOperationOwner] = useState<FileExplorerOperationOwner>({
    kind: 'unresolved'
  })

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
  const usesRuntimePathSearch =
    (runtimeEnvironmentId !== null || connectionId !== undefined) && query !== undefined
  const remoteQuery = usesRuntimePathSearch ? query.trim() : ''
  const remoteQueryTooLarge = usesRuntimePathSearch && isQuickOpenRemoteQueryTooLarge(remoteQuery)
  const listingKey = `${worktreePath ?? ''}\n${operationOwnerKey}\n${excludeRequest.key}\n${activeTargetStatus ?? ''}`
  // Why: a capped listing can omit matches, so only then pay for a host scan per query.
  const hostNameFilter =
    hostFilterWhenCapped &&
    runtimeEnvironmentId === null &&
    connectionId === undefined &&
    cappedLocalListing?.key === listingKey &&
    !cappedLocalListing.hostFilterFailed
      ? splitFileNameFilterTokens(query ?? '').join(' ')
      : ''
  const requestKey = `${listingKey}${usesRuntimePathSearch ? `\n${remoteQuery}` : ''}${hostNameFilter ? `\nname-filter\n${hostNameFilter}` : ''}`
  // Why: the render between a request change and the effect that starts the next request must
  // not show the previous listing, so a listing is only visible for the request that produced it.
  const currentListing = listing.requestKey === requestKey ? listing : NO_LISTING
  const startsRequest =
    enabled &&
    target.canList &&
    operationRouteAvailable &&
    !(usesRuntimePathSearch && (remoteQuery.length === 0 || remoteQueryTooLarge))
  // Why: in that same gap the effect has not flipped loading yet, so fall back to whether this
  // render is going to start a request — otherwise the empty listing reads as "no results".
  const loading = loadingRequest.requestKey === requestKey ? loadingRequest.loading : startsRequest

  useEffect(() => {
    if (!enabled) {
      setCappedLocalListing(null)
      setLoadingRequest({ requestKey, loading: false })
      setListedOperationOwner({ kind: 'unresolved' })
      return
    }

    if (!target.canList || !worktreeId || !worktreePath || !operationRouteAvailable) {
      setListing(NO_LISTING)
      setListedOperationOwner({ kind: 'unresolved' })
      setLoadError(!operationRouteAvailable ? getFileExplorerOwnerUnresolvedMessage() : null)
      setLoadingRequest({ requestKey, loading: false })
      return
    }

    let cancelled = false
    setLoadError(null)

    if (usesRuntimePathSearch && (remoteQuery.length === 0 || remoteQueryTooLarge)) {
      setListing(NO_LISTING)
      setLoadingRequest({ requestKey, loading: false })
      setListedOperationOwner(operationOwnerRef.current)
      return
    }

    setLoadingRequest({ requestKey, loading: true })

    const excludePaths = excludeRequest.paths.length > 0 ? excludeRequest.paths : undefined
    const requestToken = createBrowserUuid()
    const requestAbortController = new AbortController()
    const requestOperationOwner = operationOwnerRef.current
    const requestContext = {
      settings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
      worktreeId,
      worktreePath,
      connectionId
    }

    const listFiles = (nameFilter?: string) =>
      listRuntimeFiles(requestContext, {
        rootPath: worktreePath,
        excludePaths,
        requestToken,
        maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
        ...(nameFilter ? { nameFilter } : {}),
        signal: requestAbortController.signal
      }).then((files) => ({
        // #12547: naming the cap is what makes a full page readable as "there is more". Reporting
        // false unconditionally is what made the truncation silent — the host bounds the scan to
        // the cap it is given, so a full page means there are more paths behind it.
        files,
        truncated: files.length >= QUICK_OPEN_LISTING_MAX_RESULTS
      }))
    const request = usesRuntimePathSearch
      ? debounceRuntimeFileRequest(120, requestAbortController.signal, () =>
          searchRuntimeFilePaths(requestContext, {
            query: remoteQuery,
            limit: 32,
            excludePaths,
            ...(connectionId ? { requestToken } : {}),
            signal: requestAbortController.signal
          })
        )
      : hostNameFilter
        ? debounceRuntimeFileRequest(120, requestAbortController.signal, () =>
            listFiles(hostNameFilter)
          )
        : listFiles()

    void request
      .then((result) => {
        if (!cancelled) {
          setListing({ requestKey, ...result })
          setListedOperationOwner(requestOperationOwner)
          if (!usesRuntimePathSearch && !hostNameFilter) {
            setCappedLocalListing((current) =>
              nextCappedLocalListing(current, listingKey, result.truncated)
            )
          }
        }
      })
      .catch((error) => {
        if (!cancelled && hostNameFilter) {
          // Why: a failed host scan falls back to filtering the capped listing, not an error.
          setCappedLocalListing((current) => current && { ...current, hostFilterFailed: true })
        } else if (!cancelled) {
          setListing(NO_LISTING)
          setLoadError(cleanRuntimeFileListError(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRequest({ requestKey, loading: false })
        }
      })

    return () => {
      cancelled = true
      requestAbortController.abort()
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
    hostNameFilter,
    listingKey,
    runtimeEnvironmentId,
    target.canList,
    worktreeId,
    worktreePath,
    remoteQuery,
    remoteQueryTooLarge,
    usesRuntimePathSearch
  ])

  return {
    files: currentListing.files,
    loading: loading || connectionPending,
    loadError,
    truncated: currentListing.truncated,
    operationOwner: listedOperationOwner
  }
}
