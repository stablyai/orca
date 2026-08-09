import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import type { NestedRepoCandidate, Worktree } from '../../../../shared/types'
import { FolderRepoRow, type RepoStatusState } from './folder-source-control-rows'
import { FolderSourceControlDetails } from './folder-source-control-details'
import {
  mergeFolderGitTargets,
  selectFolderSourceControlRepos
} from './folder-source-control-repos'

const FOLDER_STATUS_POLL_MS = 30_000

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
  const candidateRepos = useAppStore(
    useShallow((state) => selectFolderSourceControlRepos(state, activeWorktreeId, activeRepo))
  )
  const settings = useAppStore((state) => state.settings)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const scanNestedRepos = useAppStore((state) => state.scanNestedRepos)
  const [repoStatuses, setRepoStatuses] = useState<Record<string, RepoStatusState>>({})
  const [scannedRepos, setScannedRepos] = useState<NestedRepoCandidate[]>([])
  const [scanning, setScanning] = useState(false)
  const [expandedRepoKeys, setExpandedRepoKeys] = useState<Set<string>>(() => new Set())
  const parentPath = activeWorktree?.path ?? activeRepo?.path ?? ''
  const workspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const folderConnectionId = useMemo(() => {
    if (folderWorkspaceId) {
      return getFolderWorkspaceConnectionId(useAppStore.getState(), folderWorkspaceId) ?? null
    }
    return activeRepo?.connectionId ?? null
  }, [activeRepo?.connectionId, folderWorkspaceId])
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
      Object.values(repoStatuses).reduce(
        (sum, state) => sum + (state.status?.statusLength ?? state.status?.entries.length ?? 0),
        0
      ),
    [repoStatuses]
  )

  useEffect(() => {
    setExpandedRepoKeys(new Set())
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
      await Promise.all(
        targets.map(async (target) => {
          const worktree = target.repo ? getPrimaryWorktree(worktreesByRepo, target.repo.id) : null
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
                settings: getRepoOwnerRoutedSettings(settings, {
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
      )
    },
    [settings, targets, worktreesByRepo]
  )

  useEffect(() => {
    const controller = new AbortController()
    void refreshStatuses(controller.signal)
    const interval = window.setInterval(() => {
      void refreshStatuses()
    }, FOLDER_STATUS_POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [refreshStatuses])

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

  if (!parentPath) {
    return null
  }
  if (!activeRepo && workspaceScope?.type !== 'folder') {
    return null
  }
  if (activeRepo && !isFolderRepo(activeRepo) && workspaceScope?.type !== 'folder') {
    return null
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
        <span className="min-w-0 flex-1 truncate">
          {translate('auto.components.right.sidebar.index.0314901467', 'Source Control')}
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
                    onBranchChanged={() => void refreshStatuses()}
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
