import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname } from '@/lib/path'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { GitStatusEntry, GitStatusResult } from '../../../../../../shared/git-status-types'
import type { NestedRepoCandidate } from '../../../../../../shared/project-group-types'
import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import { STATUS_COLORS, STATUS_LABELS } from '../../status-display'
import {
  resolveFolderSourceControlRepositories,
  type FolderSourceControlRepository
} from './folder-repository-resolution'

const STATUS_REFRESH_INTERVAL_MS = 60_000
const STATUS_REFRESH_CONCURRENCY = 4

type RepositoryStatus =
  | { state: 'loading' }
  | { state: 'ready'; status: GitStatusResult }
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string }

const AREA_LABELS: Record<GitStatusEntry['area'], { key: string; fallback: string }> = {
  staged: {
    key: 'auto.components.right.sidebar.SourceControl.48a003c1b1',
    fallback: 'Staged Changes'
  },
  unstaged: {
    key: 'auto.components.right.sidebar.SourceControl.d4ef4bafc5',
    fallback: 'Changes'
  },
  untracked: {
    key: 'auto.components.right.sidebar.SourceControl.522f44dce5',
    fallback: 'Untracked Files'
  }
}

function ChangedFileRow({ entry }: { entry: GitStatusEntry }): React.JSX.Element {
  const FileIcon = getFileTypeIcon(entry.path)
  const parent = dirname(entry.path)
  return (
    <div
      className="flex min-h-6 items-center gap-1 px-5 py-1 text-xs hover:bg-accent/40"
      title={entry.path}
    >
      {createElement(FileIcon, {
        className: 'size-3.5 shrink-0',
        style: { color: STATUS_COLORS[entry.status] }
      })}
      <span className="min-w-0 flex-1 truncate text-foreground">
        {basename(entry.path)}
        {parent !== '.' && (
          <span className="ml-1.5 text-[11px] text-muted-foreground">{parent}</span>
        )}
      </span>
      <span
        className="w-4 shrink-0 text-center text-[10px] font-bold"
        style={{ color: STATUS_COLORS[entry.status] }}
      >
        {STATUS_LABELS[entry.status]}
      </span>
    </div>
  )
}

function RepositoryChanges({ status }: { status: GitStatusResult }): React.JSX.Element {
  if (status.entries.length === 0) {
    return (
      <div className="px-5 py-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.folderSourceControl.clean',
          'No uncommitted changes'
        )}
      </div>
    )
  }

  return (
    <>
      {(['staged', 'unstaged', 'untracked'] as const).map((area) => {
        const entries = status.entries.filter((entry) => entry.area === area)
        if (entries.length === 0) {
          return null
        }
        return (
          <div key={area}>
            <div className="px-5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
              {translate(AREA_LABELS[area].key, AREA_LABELS[area].fallback)}{' '}
              <span className="tabular-nums">{entries.length}</span>
            </div>
            {entries.map((entry) => (
              <ChangedFileRow key={`${entry.area}:${entry.path}`} entry={entry} />
            ))}
          </div>
        )
      })}
    </>
  )
}

function RepositorySection({
  repository,
  result
}: {
  repository: FolderSourceControlRepository
  result: RepositoryStatus | undefined
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const status = result?.state === 'ready' ? result.status : null
  const count = status?.entries.length
  const branch = status?.branch ?? repository.worktree?.branch

  return (
    <section className="border-b border-border last:border-b-0">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start text-left"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', collapsed && '-rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {repository.candidate.displayName}
        </span>
        {branch && (
          <span className="flex min-w-0 items-center gap-1 text-[11px] font-normal text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="max-w-28 truncate">{branch}</span>
          </span>
        )}
        {count !== undefined && (
          <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </Button>

      {!collapsed && (
        <div className="pb-1">
          {!result || result.state === 'loading' ? (
            <div className="flex items-center gap-2 px-5 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {translate(
                'auto.components.right.sidebar.folderSourceControl.loadingStatus',
                'Loading changes…'
              )}
            </div>
          ) : result.state === 'ready' ? (
            <RepositoryChanges status={result.status} />
          ) : (
            <div className="px-5 py-2 text-xs text-muted-foreground">{result.message}</div>
          )}
        </div>
      )}
    </section>
  )
}

export function FolderSourceControlPanel({
  folderPath,
  connectionId,
  executionHostId,
  runtimeEnvironmentId,
  runtimeSettings
}: {
  folderPath: string
  connectionId: string | null
  executionHostId: string
  runtimeEnvironmentId: string | null
  runtimeSettings: Parameters<typeof getRuntimeGitStatus>[0]['settings']
}): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const scanNestedRepos = useAppStore((state) => state.scanNestedRepos)
  const [candidates, setCandidates] = useState<NestedRepoCandidate[]>([])
  const [scanState, setScanState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [statuses, setStatuses] = useState<Record<string, RepositoryStatus>>({})
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

  const scan = useCallback(async () => {
    const generation = ++scanGeneration.current
    setScanState('loading')
    const result = await scanNestedRepos(folderPath, connectionId ?? undefined, {
      runtimeEnvironmentId
    })
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
            next[candidate.path] = { state: 'loading' }
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
    [connectionId, repositories, runtimeEnvironmentId, runtimeSettings]
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
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {translate(
            'auto.components.right.sidebar.folderSourceControl.repositories',
            'Repositories'
          )}
        </span>
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
            <RepositorySection
              key={repository.candidate.path}
              repository={repository}
              result={statuses[repository.candidate.path]}
            />
          ))
        )}
      </div>
    </div>
  )
}
