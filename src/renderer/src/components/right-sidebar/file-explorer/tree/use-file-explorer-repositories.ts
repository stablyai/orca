import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useFileListOperationOwner,
  getFileExplorerOperationRoute
} from '../navigation/file-explorer-operation-owner'
import {
  getRuntimeGitStatus,
  supportsRuntimeGitRepositories
} from '@/runtime/source-control/git/runtime-git-status-client'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../../../shared/cross-platform-path'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'
import type { UseFileExplorerTreeResult } from './file-explorer-types'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource,
  type ExplorerRepositoryChange
} from './file-explorer-repository-observer'

import type { ExplorerRepositoryDemand } from './file-explorer-repository-paths'
import { buildExplorerRepositoryFrontier } from './file-explorer-repository-frontier'

const NO_SOURCES: readonly ExplorerRepositorySource[] = []

export function useFileExplorerRepositories(
  workspaceId: string | null,
  root: string | null,
  displayRoot: string | null,
  tree: UseFileExplorerTreeResult,
  expanded: ReadonlySet<string>,
  enabled: boolean,
  hasRootGitSource: boolean
) {
  const owner = useFileListOperationOwner(workspaceId)
  const ownerKey = JSON.stringify(owner)
  const identity = JSON.stringify([workspaceId, root, ownerKey])
  const observer = useRef<FileExplorerRepositoryObserver | null>(null)
  const demand = useRef<{ identity: string; paths: readonly string[] } | null>(null)
  const [answer, setAnswer] = useState<{
    identity: string
    sources: readonly ExplorerRepositorySource[]
  } | null>(null)
  const frontier = useMemo(() => {
    if (!root || !displayRoot) {
      return { candidates: [], dependencies: [], retainedSubtrees: [] }
    }
    return buildExplorerRepositoryFrontier(
      root,
      displayRoot,
      tree.sourceWorkspaceId === workspaceId ? tree.dirCache : {},
      expanded,
      JSON.parse(ownerKey),
      hasRootGitSource
    )
  }, [
    root,
    displayRoot,
    tree.dirCache,
    tree.sourceWorkspaceId,
    workspaceId,
    ownerKey,
    expanded,
    hasRootGitSource
  ])
  const frontierRef = useRef(frontier)
  frontierRef.current = frontier
  useEffect(() => {
    const route = getFileExplorerOperationRoute(JSON.parse(ownerKey))
    if (!workspaceId || !root || !route) {
      return
    }
    let live = true
    const instance = new FileExplorerRepositoryObserver(
      async (request, signal) => {
        const result = await getRuntimeGitStatus(
          { ...route, worktreeId: workspaceId, worktreePath: root },
          { ...request, admissionTier: 'background', signal }
        )
        const records = result.repositoryStatuses
        return Array.isArray(records) &&
          records.every(
            (record) =>
              record &&
              typeof record.path === 'string' &&
              ['repository', 'absent', 'unknown'].includes(record.kind) &&
              (!record.status || Array.isArray(record.status.entries)) &&
              (!record.ignoredPaths || Array.isArray(record.ignoredPaths))
          )
          ? records
          : undefined
      },
      (sources) => {
        if (live) {
          setAnswer({ identity, sources })
        }
      },
      () =>
        supportsRuntimeGitRepositories({ ...route, worktreeId: workspaceId, worktreePath: root })
    )
    observer.current = instance
    if (demand.current?.identity === identity) {
      instance.setDemand(demand.current.paths)
    }
    instance.setFrontier(
      frontierRef.current.candidates,
      frontierRef.current.dependencies,
      frontierRef.current.retainedSubtrees
    )
    const environmentId = route.target.kind === 'environment' ? route.target.environmentId : null
    const unsubscribe = environmentId
      ? subscribeRuntimeHostContactRegained(environmentId, () => instance.invalidate())
      : undefined
    const changed = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeFileChangeEventDetail>).detail
      if (
        !detail ||
        (detail.runtimeEnvironmentId ?? null) !== environmentId ||
        (detail.payload.connectionId ?? undefined) !== route.connectionId ||
        normalizeRuntimePathForComparison(detail.payload.worktreePath) !==
          normalizeRuntimePathForComparison(root)
      ) {
        return
      }
      const changes: ExplorerRepositoryChange[] = []
      for (const change of detail.payload.events) {
        if (change.kind === 'overflow') {
          instance.invalidate()
          return
        }
        const path = relativePathInsideRoot(root, change.absolutePath)
        if (path !== null) {
          changes.push({ path, directory: change.isDirectory, kind: change.kind })
        }
        if (change.oldAbsolutePath) {
          const old = relativePathInsideRoot(root, change.oldAbsolutePath)
          if (old !== null) {
            changes.push({ path: old, kind: 'delete' })
          }
        }
      }
      instance.invalidateChanges(changes)
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, changed)
    return () => {
      live = false
      unsubscribe?.()
      instance.dispose()
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, changed)
      if (observer.current === instance) {
        observer.current = null
      }
    }
  }, [identity, workspaceId, root, ownerKey])
  useEffect(() => {
    observer.current?.setFrontier(
      frontier.candidates,
      frontier.dependencies,
      frontier.retainedSubtrees
    )
  }, [identity, frontier])
  useEffect(() => {
    const reconcile = (): void => observer.current?.setVisible(enabled && isWindowVisible())
    reconcile()
    document.addEventListener('visibilitychange', reconcile)
    return () => document.removeEventListener('visibilitychange', reconcile)
  }, [identity, enabled])
  const setDemand = useCallback(
    (paths: readonly string[], partition?: ExplorerRepositoryDemand) => {
      demand.current = { identity, paths }
      observer.current?.setDemand(paths, partition)
    },
    [identity]
  )
  const refresh = useCallback(() => observer.current?.invalidate(), [])
  return {
    sources: answer?.identity === identity ? answer.sources : NO_SOURCES,
    setDemand,
    refresh
  }
}
