import { useEffect, useMemo, useState } from 'react'
import { Check, FolderGit2, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { branchName } from '@/lib/git-utils'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { checkoutRuntimeGitBranch, fetchRuntimeGit } from '@/runtime/runtime-git-sync-client'
import { searchRuntimeRepoBaseRefDetails } from '@/runtime/runtime-repo-client'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import {
  resolveGitOperationTarget,
  tryResolveGitOperationTarget
} from '@/store/slices/editor/actions/git-operation-target'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import { branchSwitcherRows, otherWorktreeRows, worktreeRowMatches } from './branch-switcher-rows'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

const SEARCH_LIMIT = 100
const SEARCH_DEBOUNCE_MS = 150

export function BranchStatusSegment({ iconOnly }: { iconOnly: boolean }): React.JSX.Element | null {
  const worktree = useActiveWorktree()
  const repoId = worktree?.repoId ?? null
  const hostId = useAppStore((state) => {
    const repo = repoId ? findRepoForHost(state.repos, repoId, { settings: state.settings }) : null
    return repo ? getRepoExecutionHostId(repo) : null
  })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [refs, setRefs] = useState<BaseRefSearchResult[]>([])
  const [fetchRevision, setFetchRevision] = useState(0)
  const [switching, setSwitching] = useState(false)
  const worktreeId = worktree?.id ?? null
  const worktreePath = worktree?.path ?? null
  const repoWorktrees = useAppStore((state) => (repoId ? state.worktreesByRepo[repoId] : undefined))
  const projectName = useAppStore((state) =>
    repoId
      ? findRepoForHost(state.repos, repoId, { settings: state.settings })?.displayName
      : undefined
  )
  const otherWorktrees = useMemo(
    () => otherWorktreeRows(repoWorktrees ?? [], worktreeId),
    [repoWorktrees, worktreeId]
  )
  // Why: Git refuses a branch another worktree holds, so those rows go to that worktree instead.
  const rows = useMemo(() => {
    const held = new Set(otherWorktrees.map((row) => row.branch))
    return branchSwitcherRows(refs).filter((row) => !held.has(row.branch))
  }, [otherWorktrees, refs])

  useEffect(() => {
    if (!open || !worktreeId || !worktreePath) {
      return
    }
    const target = tryResolveGitOperationTarget(useAppStore.getState(), worktreeId)
    if (!target) {
      return
    }
    // Why: remote refs are only as fresh as the last fetch. It runs unasked, so failing offline
    // keeps the cached refs instead of raising a toast on every open.
    void fetchRuntimeGit({
      target,
      worktreeId,
      worktreePath,
      connectionId: getConnectionId(worktreeId) ?? undefined
    })
      .then(() => setFetchRevision((revision) => revision + 1))
      .catch((error) => {
        console.warn('[BranchStatusSegment] fetch failed', error)
      })
  }, [open, worktreeId, worktreePath])

  useEffect(() => {
    if (!open || !repoId || !hostId) {
      return
    }
    let stale = false
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefDetails(hostId, repoId, query.trim(), SEARCH_LIMIT)
        .then((results) => {
          if (!stale) {
            setRefs(results)
          }
        })
        .catch((error) => {
          console.error('[BranchStatusSegment] branch search failed', error)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [fetchRevision, hostId, open, query, repoId])

  if (!worktree?.branch) {
    return null
  }

  const current = branchName(worktree.branch)
  const worktreeRows = otherWorktrees.filter((row) => worktreeRowMatches(row, query))

  const changeOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
    }
  }

  const switchTo = async (branch: string): Promise<void> => {
    if (branch === current) {
      changeOpen(false)
      return
    }
    setSwitching(true)
    try {
      await checkoutRuntimeGitBranch(
        resolveGitOperationTarget(useAppStore.getState(), worktree.id),
        worktree.id,
        branch
      )
      changeOpen(false)
    } catch (error) {
      toast.error(
        extractIpcErrorMessage(
          error,
          translate(
            'auto.components.status.bar.BranchStatusSegment.switchFailed',
            'Could not switch branch.'
          )
        )
      )
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          className="inline-flex min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          aria-label={translate(
            'auto.components.status.bar.BranchStatusSegment.ariaLabel',
            'Switch branch, current branch {{branch}}',
            { branch: current }
          )}
        >
          <GitBranch className="size-3" />
          {!iconOnly ? (
            <span className="max-w-48 truncate text-[11px] font-medium">{current}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(360px,calc(100vw-1rem))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={translate(
              'auto.components.status.bar.BranchStatusSegment.searchPlaceholder',
              'Search branches'
            )}
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.status.bar.BranchStatusSegment.empty',
                'No branches match your search.'
              )}
            </CommandEmpty>
            {worktreeRows.length > 0 ? (
              <CommandGroup heading={projectName}>
                {worktreeRows.map((row) => (
                  <CommandItem
                    key={row.id}
                    value={`worktree:${row.id}`}
                    onSelect={() => {
                      activateAndRevealWorktree(row.id)
                      changeOpen(false)
                    }}
                    className="items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <FolderGit2 className="size-3 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{row.displayName}</span>
                    <span className="max-w-32 shrink-0 truncate text-muted-foreground">
                      {row.branch}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {rows.length > 0 ? (
              <CommandGroup
                heading={
                  worktreeRows.length > 0
                    ? translate(
                        'auto.components.status.bar.BranchStatusSegment.branchesHeading',
                        'Branches'
                      )
                    : undefined
                }
              >
                {rows.map((row) => (
                  <CommandItem
                    key={row.branch}
                    value={row.branch}
                    disabled={switching}
                    onSelect={() => void switchTo(row.branch)}
                    className="items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        row.branch === current ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
