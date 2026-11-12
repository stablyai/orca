import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
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
import { ExplorerRepositoryFrontier } from './file-explorer-repository-frontier-owner'

const EMPTY_CACHE = {}
const NO_SOURCES: readonly ExplorerRepositorySource[] = []

export function useFileExplorerRepositories(
  workspaceId: string | null,
  root: string | null,
  displayRoot: string | null,
  tree: Pick<UseFileExplorerTreeResult, 'dirCacheStore'>,
  expanded: ReadonlySet<string>,
  enabled: boolean,
  hasRootGitSource: boolean
) {
  const owner = useFileListOperationOwner(workspaceId)
  const ownerKey = JSON.stringify(owner)
  const identity = JSON.stringify([workspaceId, root, ownerKey])
  const observer = useRef<FileExplorerRepositoryObserver | null>(null)
  const frontier = useRef<ExplorerRepositoryFrontier | null>(null)
  const dirCacheStore = tree.dirCacheStore
  const demand = useRef<{ identity: string; paths: readonly string[] } | null>(null)
  const [answer, setAnswer] = useState<{
    identity: string
    sources: readonly ExplorerRepositorySource[]
  } | null>(null)
  const applyView = useEffectEvent((instance: ExplorerRepositoryFrontier) => {
    instance.setView(displayRoot, expanded, hasRootGitSource)
  })
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
    const model = new ExplorerRepositoryFrontier(root, JSON.parse(ownerKey), {
      apply: (changes, affected, retains) => instance.updateFrontier(changes, affected, retains),
      invalidate: (path) => instance.invalidateCandidate(path),
      resetProof: () => instance.invalidate(),
      branches: (path) => instance.proofBranches(path),
      invalidateSubtree: (path) => instance.invalidateProofSubtree(path)
    })
    frontier.current = model
    applyView(model)
    const commit = (
      snapshot: ReturnType<typeof dirCacheStore.getSnapshot> & {
        changedPaths: readonly string[]
        reset: boolean
      }
    ): void => {
      const current = snapshot.sourceWorkspaceId === workspaceId
      model.commit(current ? snapshot.dirCache : EMPTY_CACHE, snapshot.changedPaths, snapshot.reset)
    }
    const unsubscribeCache = dirCacheStore.subscribeChanges(commit)
    commit({ ...dirCacheStore.getSnapshot(), changedPaths: [], reset: true })
    const environmentId = route.target.kind === 'environment' ? route.target.environmentId : null
    const unsubscribe = environmentId
      ? subscribeRuntimeHostContactRegained(environmentId, () => instance.invalidate())
      : undefined
    const changed = (event: CustomEvent<WorktreeFileChangeEventDetail>): void => {
      const detail = event.detail
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
      unsubscribeCache()
      instance.dispose()
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, changed)
      if (observer.current === instance) {
        observer.current = null
        frontier.current = null
      }
    }
  }, [identity, workspaceId, root, ownerKey, dirCacheStore])
  useEffect(() => {
    frontier.current?.setView(displayRoot, expanded, hasRootGitSource)
  }, [identity, displayRoot, expanded, hasRootGitSource])
  useEffect(() => {
    const reconcile = (): void => {
      const visible = enabled && isWindowVisible()
      if (!visible) {
        observer.current?.setVisible(false)
      }
      frontier.current?.setVisible(visible)
      if (visible) {
        observer.current?.setVisible(true)
      }
    }
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
