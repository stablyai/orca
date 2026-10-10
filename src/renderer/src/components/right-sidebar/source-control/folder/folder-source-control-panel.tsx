import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { NestedRepoCandidate } from '../../../../../../shared/project-group-types'
import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import {
  resolveFolderSourceControlDiffWorktreeId,
  resolveFolderSourceControlRepositories,
  type FolderSourceControlRepository
} from './folder-repository-resolution'
import { FolderRepositorySection, type FolderRepositoryStatus } from './folder-repository-section'

const STATUS_REFRESH_INTERVAL_MS = 60_000
const STATUS_REFRESH_CONCURRENCY = 4

export function FolderSourceControlPanel({
  folderPath,
  folderWorktreeId,
  connectionId,
  executionHostId,
  runtimeEnvironmentId,
  runtimeSettings
}: {
  folderPath: string
  folderWorktreeId: string
  connectionId: string | null
  executionHostId: string
  runtimeEnvironmentId: string | null
  runtimeSettings: Parameters<typeof getRuntimeGitStatus>[0]['settings']
}): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const scanNestedRepos = useAppStore((state) => state.scanNestedRepos)
  const openDiff = useAppStore((state) => state.openDiff)
  const [candidates, setCandidates] = useState<NestedRepoCandidate[]>([])
  const [scanState, setScanState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [statuses, setStatuses] = useState<Record<string, FolderRepositoryStatus>>({})
  const scanGeneration = useRef(0)

  const repositories = useMemo(
    () =>
      resolveFolderSourceControlRepositories({
        candidates,
        repos,
        worktreesByRepo,
        executionHostId
      }),
    [candidates, executionHostId, repos, worktreesByRepo]
  )

  const openRepositoryDiff = useCallback(
    (
      repository: FolderSourceControlRepository,
      entry: GitStatusEntry,
      openAsPermanent: boolean
    ) => {
      const targetWorktreeId = resolveFolderSourceControlDiffWorktreeId({
        folderWorktreeId,
        repository,
        runtimeEnvironmentId
      })
      if (!targetWorktreeId) {
        return
      }
      openDiff(
        targetWorktreeId,
        joinPath(repository.candidate.path, entry.path),
        entry.path,
        detectLanguage(entry.path),
        entry.area === 'staged',
        {
          preview: !openAsPermanent,
          runtimeEnvironmentId: runtimeEnvironmentId ?? undefined
        }
      )
    },
    [folderWorktreeId, openDiff, runtimeEnvironmentId]
  )

  const scan = useCallback(async () => {
    const generation = ++scanGeneration.current
    setScanState('loading')
    let result: Awaited<ReturnType<typeof scanNestedRepos>> | null = null
    try {
      result = await scanNestedRepos(folderPath, connectionId ?? undefined, {
        runtimeEnvironmentId
      })
    } catch {
      result = null
    }
    if (generation !== scanGeneration.current) {
      return
    }
    if (!result) {
      setScanState('error')
      return
    }
    setCandidates(result.repos)
    setScanState('ready')
  }, [connectionId, folderPath, runtimeEnvironmentId, scanNestedRepos])

  const refreshStatuses = useCallback(
    async (signal?: AbortSignal, showLoading = true) => {
      if (repositories.length === 0) {
        return
      }
      if (showLoading) {
        setStatuses((current) => {
          const next = { ...current }
          for (const { candidate } of repositories) {
            next[candidate.path] ??= { state: 'loading' }
          }
          return next
        })
      }
      await mapWithConcurrency(repositories, STATUS_REFRESH_CONCURRENCY, async (repository) => {
        const { candidate, repo, worktree } = repository
        if (runtimeEnvironmentId && !worktree) {
          if (signal?.aborted) {
            return
          }
          setStatuses((current) => ({
            ...current,
            [candidate.path]: {
              state: 'unavailable',
              message: translate(
                'auto.components.right.sidebar.folderSourceControl.addRepository',
                'Add this repository to Orca to load its changes'
              )
            }
          }))
          return
        }
        try {
          const settings = worktree
            ? getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktree.id)
            : runtimeSettings
          const status = await getRuntimeGitStatus(
            {
              settings,
              worktreeId: worktree?.id ?? null,
              worktreePath: candidate.path,
              authorizedParentPath: folderPath,
              connectionId: repo?.connectionId ?? connectionId ?? undefined
            },
            { admissionTier: 'status', includeLineStats: false, signal }
          )
          if (signal?.aborted) {
            return
          }
          setStatuses((current) => ({
            ...current,
            [candidate.path]: { state: 'ready', status }
          }))
        } catch (error) {
          if (signal?.aborted) {
            return
          }
          setStatuses((current) => ({
            ...current,
            [candidate.path]: {
              state: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : translate(
                      'auto.components.right.sidebar.folderSourceControl.statusError',
                      'Failed to load changes'
                    )
            }
          }))
        }
      })
    },
    [connectionId, folderPath, repositories, runtimeEnvironmentId, runtimeSettings]
  )

  useEffect(() => {
    void scan()
    return () => {
      scanGeneration.current += 1
    }
  }, [scan])

  useEffect(() => {
    const controller = new AbortController()
    void refreshStatuses(controller.signal)
    const interval = window.setInterval(
      () => void refreshStatuses(controller.signal, false),
      STATUS_REFRESH_INTERVAL_MS
    )
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [refreshStatuses])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">
            {translate(
              'auto.components.right.sidebar.folderSourceControl.repositories',
              'Repositories'
            )}
          </span>
          {scanState === 'ready' && (
            <span className="block text-[10px] tabular-nums text-muted-foreground">
              {repositories.length}
            </span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void scan()}
              disabled={scanState === 'loading'}
              aria-label={translate(
                'auto.components.right.sidebar.folderSourceControl.refresh',
                'Refresh repositories'
              )}
            >
              {scanState === 'loading' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.right.sidebar.folderSourceControl.refresh',
              'Refresh repositories'
            )}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-auto scrollbar-sleek">
        {scanState === 'error' ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.folderSourceControl.scanError',
              'Failed to scan this folder for repositories'
            )}
          </div>
        ) : scanState === 'ready' && repositories.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.folderSourceControl.empty',
              'No Git repositories found in this folder'
            )}
          </div>
        ) : (
          repositories.map((repository) => (
            <FolderRepositorySection
              key={repository.candidate.path}
              repository={repository}
              result={statuses[repository.candidate.path]}
              onOpen={(entry, openAsPermanent) =>
                openRepositoryDiff(repository, entry, openAsPermanent)
              }
            />
          ))
        )}
      </div>
    </div>
  )
}
