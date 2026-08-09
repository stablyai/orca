import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import type { NestedRepoCandidate, Worktree } from '../../../../shared/types'
import { FolderRepoRow, type RepoStatusState } from './folder-source-control-rows'
import { FolderSourceControlDetails } from './folder-source-control-details'
import {
  mergeFolderGitTargets,
  selectFolderSourceControlRepos
} from './folder-source-control-repos'
import { useFolderSourceControlScope } from './use-folder-source-control-scope'

const FOLDER_STATUS_POLL_MS = 30_000
const FOLDER_STATUS_CONCURRENCY = 4

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await worker(item)
    }
  })
  await Promise.all(workers)
}

function getPrimaryWorktree(
  worktreesByRepo: Record<string, Worktree[]>,
  repoId: string
): Worktree | null {
  const worktrees = worktreesByRepo[repoId] ?? []
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

export default function FolderSourceControl(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const isFolderScope = useFolderSourceControlScope(activeWorktreeId, activeRepo)
  const candidateRepos = useAppStore(
    useShallow((state) => selectFolderSourceControlRepos(state, activeWorktreeId, activeRepo))
  )
  const settings = useAppStore((state) => state.settings)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const scanNestedRepos = useAppStore((state) => state.scanNestedRepos)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const worktreesByRepoRef = useRef(worktreesByRepo)
  worktreesByRepoRef.current = worktreesByRepo
  const statusRefreshAbortRef = useRef<AbortController | null>(null)
  const statusRefreshPromiseRef = useRef<Promise<void> | null>(null)
  const [repoStatuses, setRepoStatuses] = useState<Record<string, RepoStatusState>>({})
  const [scannedRepos, setScannedRepos] = useState<NestedRepoCandidate[]>([])
  const [scanning, setScanning] = useState(false)
  const [expandedRepoKeys, setExpandedRepoKeys] = useState<Set<string>>(() => new Set())
  const parentPath = activeWorktree?.path ?? activeRepo?.path ?? ''
  const workspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const workspaceConnectionId = useAppStore((state) =>
    folderWorkspaceId ? (getFolderWorkspaceConnectionId(state, folderWorkspaceId) ?? null) : null
  )
  const folderConnectionId = folderWorkspaceId
    ? workspaceConnectionId
    : (activeRepo?.connectionId ?? null)
  const folderExecutionHostId = activeRepo?.executionHostId ?? null
  const targets = useMemo(
    () =>
      mergeFolderGitTargets({
        repos: candidateRepos,
        scannedRepos,
        parentPath,
        connectionId: folderConnectionId,
        executionHostId: folderExecutionHostId
      }),
    [candidateRepos, folderConnectionId, folderExecutionHostId, parentPath, scannedRepos]
  )
  const targetKey = targets.map((target) => target.key).join('\0')
  const totalChangeCount = useMemo(
    () =>
      targets.reduce((sum, target) => {
        const state = repoStatuses[target.key]
        return sum + (state?.status?.statusLength ?? state?.status?.entries.length ?? 0)
      }, 0),
    [repoStatuses, targets]
  )

  useEffect(() => {
    setExpandedRepoKeys(new Set())
    setRepoStatuses((current) => {
      const allowed = new Set(targetKey.split('\0'))
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => allowed.has(key)))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [targetKey])

  useEffect(() => {
    if (!parentPath) {
      return
    }
    let stale = false
    setScannedRepos([])
    setScanning(true)
    void scanNestedRepos(parentPath, folderConnectionId ?? undefined)
      .then((scan) => {
        if (!stale && scan?.selectedPathKind === 'non_git_folder') {
          setScannedRepos(scan.repos)
        }
      })
      .finally(() => {
        if (!stale) {
          setScanning(false)
        }
      })
    return () => {
      stale = true
    }
  }, [folderConnectionId, parentPath, scanNestedRepos])

  const refreshStatuses = useCallback(
    async (signal?: AbortSignal) => {
      await runWithConcurrency(targets, FOLDER_STATUS_CONCURRENCY, async (target) => {
        const worktree = target.repo
          ? getPrimaryWorktree(worktreesByRepoRef.current, target.repo.id)
          : null
        setRepoStatuses((current) => {
          if (current[target.key]?.status) {
            return current
          }
          return {
            ...current,
            [target.key]: { status: null, error: null, loading: true }
          }
        })
        try {
          const status = await getRuntimeGitStatus(
            {
              settings: getRepoOwnerRoutedSettings(settingsRef.current, {
                id: target.key,
                connectionId: target.connectionId,
                executionHostId: target.executionHostId
              }),
              worktreeId: worktree?.id ?? null,
              worktreePath: worktree?.path ?? target.path,
              connectionId: target.connectionId ?? undefined
            },
            { signal }
          )
          if (signal?.aborted) {
            return
          }
          setRepoStatuses((current) => ({
            ...current,
            [target.key]: { status, error: null, loading: false }
          }))
        } catch (error) {
          if (signal?.aborted) {
            return
          }
          setRepoStatuses((current) => ({
            ...current,
            [target.key]: {
              status: current[target.key]?.status ?? null,
              error: error instanceof Error ? error.message : String(error),
              loading: false
            }
          }))
        }
      })
    },
    [targets]
  )

  const runRefreshStatuses = useCallback(
    (force = false): Promise<void> => {
      if (statusRefreshPromiseRef.current) {
        if (!force) {
          return statusRefreshPromiseRef.current
        }
        statusRefreshAbortRef.current?.abort()
      }
      const controller = new AbortController()
      const promise = refreshStatuses(controller.signal)
      let tracked: Promise<void>
      tracked = promise.finally(() => {
        if (statusRefreshPromiseRef.current === tracked) {
          statusRefreshPromiseRef.current = null
          statusRefreshAbortRef.current = null
        }
      })
      statusRefreshPromiseRef.current = tracked
      statusRefreshAbortRef.current = controller
      return tracked
    },
    [refreshStatuses]
  )

  useEffect(() => {
    void runRefreshStatuses()
    const interval = window.setInterval(() => {
      void runRefreshStatuses()
    }, FOLDER_STATUS_POLL_MS)
    return () => {
      statusRefreshAbortRef.current?.abort()
      window.clearInterval(interval)
    }
  }, [runRefreshStatuses])

  const toggleExpanded = useCallback((key: string) => {
    setExpandedRepoKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  if (!parentPath || !isFolderScope) {
    return null
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
        <span className="min-w-0 flex-1 truncate">
          {translate(
            'auto.components.right.sidebar.FolderSourceControl.e47ef8bc62',
            'Source Control'
          )}
        </span>
        {scanning ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        {totalChangeCount > 0 ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">{totalChangeCount}</span>
        ) : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-sleek pt-1">
        {targets.map((target) => {
          const worktree = target.repo ? getPrimaryWorktree(worktreesByRepo, target.repo.id) : null
          const isExpanded = expandedRepoKeys.has(target.key)
          return (
            <div key={target.key}>
              <FolderRepoRow
                target={target}
                parentPath={parentPath}
                statusState={repoStatuses[target.key]}
                isExpanded={isExpanded}
                onToggleExpanded={() => toggleExpanded(target.key)}
              />
              {isExpanded ? (
                <div className="pl-2">
                  <FolderSourceControlDetails
                    target={target}
                    worktree={worktree}
                    statusState={repoStatuses[target.key]}
                    settings={settings}
                    onBranchChanged={() => void runRefreshStatuses(true)}
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
