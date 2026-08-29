import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, GitFork, Loader2, Lock, RefreshCw, Search, Star } from 'lucide-react'
import { toast } from 'sonner'
import type { GitHubAccountRepo } from '../../../../shared/github-account'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { isWindowsUserAgent } from '../terminal-pane/pane-helpers'
import { getDefaultProjectsCloneParent } from '../sidebar/clone-defaults'
import { findAddedGitHubRepo } from './github-added-repo-match'
import { cloneGitHubRepoIntoProjects } from './github-repo-clone-action'
import { isClonedRepoCleanupEligible } from './github-cloned-repo-cleanup-eligibility'

// Why: the Recycle Bin is Windows-only vocabulary; macOS and Linux say Trash.
const trashName = isWindowsUserAgent() ? 'Recycle Bin' : 'Trash'

function filterRepos(repos: readonly GitHubAccountRepo[], query: string): GitHubAccountRepo[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...repos]
  }
  return repos.filter(
    (repo) =>
      repo.fullName.toLowerCase().includes(needle) ||
      (repo.description?.toLowerCase().includes(needle) ?? false)
  )
}

function RepoRow({
  item,
  addedRepo,
  cleanupEligible,
  cloning,
  progress,
  onClone,
  onRemove,
  onCleanup
}: {
  item: GitHubAccountRepo
  addedRepo: Repo | null
  cleanupEligible: boolean
  cloning: boolean
  progress: { phase: string; percent: number } | null
  onClone: (item: GitHubAccountRepo) => void
  onRemove: (repo: Repo) => void
  onCleanup: (repo: Repo) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
      {item.ownerAvatarUrl ? (
        <img src={item.ownerAvatarUrl} alt="" className="size-7 shrink-0 rounded-full" />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
          {item.ownerLogin.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{item.fullName}</span>
          {item.isPrivate ? (
            <Lock
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={translate(
                'auto.components.github-panel.GitHubRepoList.private',
                'Private'
              )}
            />
          ) : null}
          {item.isFork ? (
            <GitFork
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={translate('auto.components.github-panel.GitHubRepoList.fork', 'Fork')}
            />
          ) : null}
        </div>
        {item.description ? (
          <p className="truncate text-[12px] text-muted-foreground">{item.description}</p>
        ) : null}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
          {item.language ? <span>{item.language}</span> : null}
          {item.stargazersCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Star className="size-3" />
              {item.stargazersCount}
            </span>
          ) : null}
          {item.pushedAt ? (
            <span>
              {translate('auto.components.github-panel.GitHubRepoList.pushed', 'pushed {{when}}', {
                when: formatUiRelativeTimeFromDate(item.pushedAt)
              })}
            </span>
          ) : null}
        </div>
      </div>
      {addedRepo ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1 text-muted-foreground"
              aria-label={translate(
                'auto.components.github-panel.GitHubRepoList.addedActions',
                'Added — project actions'
              )}
            >
              <Check className="size-3.5" />
              {translate('auto.components.github-panel.GitHubRepoList.added', 'Added')}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRemove(addedRepo)}>
              {translate(
                'auto.components.github-panel.GitHubRepoList.removeFromOrca',
                'Remove from Orca'
              )}
            </DropdownMenuItem>
            {cleanupEligible ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onCleanup(addedRepo)}>
                {translate(
                  'auto.components.github-panel.GitHubRepoList.cleanupFiles',
                  'Remove and move files to {{trashName}}',
                  { trashName }
                )}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={cloning}
          onClick={() => onClone(item)}
        >
          {cloning ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              {progress ? `${progress.percent}%` : null}
            </span>
          ) : (
            translate('auto.components.github-panel.GitHubRepoList.clone', 'Clone')
          )}
        </Button>
      )}
    </div>
  )
}

export function GitHubRepoList(): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const workspaceDir = useAppStore((state) => state.settings?.workspaceDir)
  const removeProject = useAppStore((state) => state.removeProject)
  const confirm = useConfirmationDialog()
  const [items, setItems] = useState<GitHubAccountRepo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [cloningId, setCloningId] = useState<number | null>(null)
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.githubAuth.listRepos()
      if (result?.ok) {
        setItems(result.repos)
      } else {
        setError(
          (result && !result.ok ? result.error : null) ??
            translate(
              'auto.components.github-panel.GitHubRepoList.loadFailed',
              'Could not load repositories.'
            )
        )
      }
    } catch {
      setError(
        translate(
          'auto.components.github-panel.GitHubRepoList.loadFailed',
          'Could not load repositories.'
        )
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (cloningId === null) {
      return
    }
    return window.api.repos.onCloneProgress(setProgress)
  }, [cloningId])

  const filtered = useMemo(() => filterRepos(items, query), [items, query])

  const clone = useCallback(
    async (item: GitHubAccountRepo): Promise<void> => {
      const destination = workspaceDir ? getDefaultProjectsCloneParent(workspaceDir) : ''
      if (!destination) {
        toast.error(
          translate(
            'auto.components.github-panel.GitHubRepoList.noWorkspaceDir',
            'Set a workspace directory in Settings first.'
          )
        )
        return
      }
      setCloningId(item.id)
      setProgress(null)
      try {
        const outcome = await cloneGitHubRepoIntoProjects(item, destination)
        if (!outcome.ok) {
          toast.error(outcome.error)
          return
        }
        toast.success(
          translate('auto.components.github-panel.GitHubRepoList.cloned', 'Repository cloned'),
          { description: item.fullName }
        )
      } finally {
        setCloningId(null)
        setProgress(null)
      }
    },
    [workspaceDir]
  )

  const removeFromOrca = useCallback(
    (repo: Repo): void => {
      void removeProject(repo.id, { errorFeedback: 'toast' })
    },
    [removeProject]
  )

  const cleanupFiles = useCallback(
    async (repo: Repo): Promise<void> => {
      const accepted = await confirm({
        title: translate(
          'auto.components.github-panel.GitHubRepoList.cleanupTitle',
          'Remove project and delete files?'
        ),
        description: translate(
          'auto.components.github-panel.GitHubRepoList.cleanupDescription',
          '“{{path}}” will be moved to the {{trashName}}, and the project will be removed from Orca.',
          { path: repo.path, trashName }
        ),
        confirmLabel: translate(
          'auto.components.github-panel.GitHubRepoList.cleanupConfirm',
          'Move to {{trashName}}',
          { trashName }
        ),
        confirmVariant: 'destructive'
      })
      if (!accepted) {
        return
      }
      const result = await window.api.githubAuth.deleteClonedRepoFiles({ repoId: repo.id })
      if (!result?.ok) {
        toast.error(
          (result && !result.ok ? result.error : null) ??
            translate(
              'auto.components.github-panel.GitHubRepoList.cleanupFailed',
              'Could not delete the repository files.'
            )
        )
        return
      }
      toast.success(
        translate(
          'auto.components.github-panel.GitHubRepoList.cleanedUp',
          'Repository files moved to the {{trashName}}',
          { trashName }
        ),
        { description: repo.path }
      )
      await removeProject(repo.id, { errorFeedback: 'toast' })
    },
    [confirm, removeProject]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 md:px-5">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              'auto.components.github-panel.GitHubRepoList.searchPlaceholder',
              'Search repositories'
            )}
            aria-label={translate(
              'auto.components.github-panel.GitHubRepoList.searchPlaceholder',
              'Search repositories'
            )}
            className="h-8 pl-7 text-[13px]"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('auto.components.github-panel.GitHubRepoList.refresh', 'Refresh')}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      </div>
      {error ? (
        <div className="mx-3 mb-2 flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive md:mx-5">
          <span>{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
            {translate('auto.components.github-panel.GitHubRepoList.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.components.github-panel.GitHubRepoList.loading',
              'Loading repositories…'
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-muted-foreground">
            {query
              ? translate(
                  'auto.components.github-panel.GitHubRepoList.noMatches',
                  'No repositories match your search.'
                )
              : translate(
                  'auto.components.github-panel.GitHubRepoList.empty',
                  'No repositories found for this account.'
                )}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border/60 pb-6">
            {filtered.map((item) => {
              const addedRepo = findAddedGitHubRepo(repos, item.fullName)
              return (
                <RepoRow
                  key={item.id}
                  item={item}
                  addedRepo={addedRepo}
                  cleanupEligible={
                    addedRepo !== null && isClonedRepoCleanupEligible(addedRepo, workspaceDir)
                  }
                  cloning={cloningId === item.id}
                  progress={cloningId === item.id ? progress : null}
                  onClone={(target) => void clone(target)}
                  onRemove={removeFromOrca}
                  onCleanup={(target) => void cleanupFiles(target)}
                />
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
