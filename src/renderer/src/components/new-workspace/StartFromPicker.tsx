/* eslint-disable max-lines -- Why: the Start-from picker keeps Branches +
Pull requests tab logic, SWR read/write, URL normalization, and stale-resolve
cancellation co-located so the popover's state machine stays inspectable in
one place. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, GitPullRequest, LoaderCircle, Search } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { normalizeGitHubLinkQuery } from '@/lib/github-links'
import type { RepoSlug } from '@/lib/github-links'
import type { GitHubWorkItem } from '../../../../shared/types'

export type StartFromSelection =
  | { kind: 'default' }
  | { kind: 'branch'; baseBranch: string }
  | { kind: 'pr'; baseBranch: string; item: GitHubWorkItem }

type StartFromPickerProps = {
  repoId: string
  repoPath: string | null
  /** Whether the selected repo is a remote SSH repo. PR tab is disabled for remote repos in v1. */
  isRemoteRepo: boolean
  onSelect: (selection: StartFromSelection) => void
  onClose: () => void
  currentBaseBranch: string | undefined
}

type PickerTab = 'branches' | 'prs'

const PR_LIST_QUERY = 'is:pr is:open'
const PR_LIST_LIMIT = 36

export default function StartFromPicker({
  repoId,
  repoPath,
  isRemoteRepo,
  onSelect,
  onClose,
  currentBaseBranch
}: StartFromPickerProps): React.JSX.Element {
  const { fetchWorkItems, getCachedWorkItems } = useAppStore(
    useShallow((s) => ({
      fetchWorkItems: s.fetchWorkItems,
      getCachedWorkItems: s.getCachedWorkItems
    }))
  )

  const [tab, setTab] = useState<PickerTab>('branches')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [repoSlug, setRepoSlug] = useState<RepoSlug | null>(null)

  // Branches tab state
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)

  // PR tab state
  const [prItems, setPrItems] = useState<GitHubWorkItem[] | null>(() => {
    if (!repoPath) {
      return null
    }
    return getCachedWorkItems(repoPath, PR_LIST_LIMIT, PR_LIST_QUERY)
  })
  const [prsLoading, setPrsLoading] = useState(false)
  const [prsError, setPrsError] = useState<string | null>(null)
  const [directPrItem, setDirectPrItem] = useState<GitHubWorkItem | null>(null)
  const [directLoading, setDirectLoading] = useState(false)

  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  // Why: a per-click token so late resolves are discarded if the user selects
  // another PR (or closes) before the first fetch/rev-parse completes.
  const resolveTokenRef = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 150)
    return () => window.clearTimeout(timer)
  }, [query])

  // Resolve slug for URL-mismatch detection.
  useEffect(() => {
    if (!repoPath) {
      setRepoSlug(null)
      return
    }
    let stale = false
    void window.api.gh
      .repoSlug({ repoPath })
      .then((slug) => {
        if (!stale) {
          setRepoSlug(slug)
        }
      })
      .catch(() => {
        if (!stale) {
          setRepoSlug(null)
        }
      })
    return () => {
      stale = true
    }
  }, [repoPath])

  // Branches fetch (debounced, only when active).
  useEffect(() => {
    if (tab !== 'branches') {
      return
    }
    const trimmed = debouncedQuery.trim()
    let stale = false
    setBranchesLoading(true)
    void window.api.repos
      .searchBaseRefs({ repoId, query: trimmed || '', limit: 30 })
      .then((results) => {
        if (!stale) {
          setBranches(results)
        }
      })
      .catch(() => {
        if (!stale) {
          setBranches([])
        }
      })
      .finally(() => {
        if (!stale) {
          setBranchesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [tab, debouncedQuery, repoId])

  const normalizedPrQuery = useMemo(
    () => normalizeGitHubLinkQuery(debouncedQuery, repoSlug),
    [debouncedQuery, repoSlug]
  )

  // PR list fetch (cached-first).
  useEffect(() => {
    if (tab !== 'prs' || isRemoteRepo || !repoPath) {
      return
    }
    const trimmed = debouncedQuery.trim()
    const directNumber = normalizedPrQuery.directNumber

    if (directNumber !== null) {
      return // handled by the direct-lookup effect
    }

    const q =
      trimmed && !normalizedPrQuery.repoMismatch
        ? `${PR_LIST_QUERY} ${normalizedPrQuery.query}`
        : PR_LIST_QUERY

    const cached = getCachedWorkItems(repoPath, PR_LIST_LIMIT, q)
    if (cached !== null) {
      setPrItems(cached.filter((i) => i.type === 'pr'))
    }

    let stale = false
    setPrsLoading(cached === null)
    setPrsError(null)
    void fetchWorkItems(repoId, repoPath, PR_LIST_LIMIT, q)
      .then((items) => {
        if (!stale) {
          setPrItems(items.filter((i) => i.type === 'pr'))
          setPrsLoading(false)
        }
      })
      .catch((err) => {
        if (!stale) {
          const message = err instanceof Error ? err.message : 'Failed to load PRs.'
          setPrsError(message)
          setPrsLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    tab,
    isRemoteRepo,
    repoId,
    repoPath,
    debouncedQuery,
    normalizedPrQuery.directNumber,
    normalizedPrQuery.query,
    normalizedPrQuery.repoMismatch,
    fetchWorkItems,
    getCachedWorkItems
  ])

  // Direct-number PR lookup.
  useEffect(() => {
    if (tab !== 'prs' || isRemoteRepo || !repoPath) {
      return
    }
    const directNumber = normalizedPrQuery.directNumber
    if (directNumber === null) {
      setDirectPrItem(null)
      setDirectLoading(false)
      return
    }
    let stale = false
    setDirectLoading(true)
    void window.api.gh
      .workItem({ repoPath, number: directNumber })
      .then((item) => {
        if (stale) {
          return
        }
        const gh = item as GitHubWorkItem | null
        // Why: a `#N` that collides with an issue must render as no-match in
        // the PR tab, not silently swap the selection to an issue.
        setDirectPrItem(gh && gh.type === 'pr' ? gh : null)
      })
      .catch(() => {
        if (!stale) {
          setDirectPrItem(null)
        }
      })
      .finally(() => {
        if (!stale) {
          setDirectLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [tab, isRemoteRepo, repoPath, normalizedPrQuery.directNumber])

  const handleBranchSelect = useCallback(
    (ref: string) => {
      onSelect({ kind: 'branch', baseBranch: ref })
      onClose()
    },
    [onClose, onSelect]
  )

  const handlePrSelect = useCallback(
    async (item: GitHubWorkItem) => {
      if (item.type !== 'pr') {
        return
      }
      const token = ++resolveTokenRef.current
      setResolving(true)
      setResolveError(null)
      try {
        const result = await window.api.worktrees.resolvePrBase({
          repoId,
          prNumber: item.number,
          ...(item.branchName ? { headRefName: item.branchName } : {}),
          ...(item.isCrossRepository !== undefined
            ? { isCrossRepository: item.isCrossRepository }
            : {})
        })
        if (token !== resolveTokenRef.current) {
          return
        }
        if ('error' in result) {
          setResolveError(result.error)
          setResolving(false)
          return
        }
        onSelect({ kind: 'pr', baseBranch: result.baseBranch, item })
        setResolving(false)
        onClose()
      } catch (err) {
        if (token !== resolveTokenRef.current) {
          return
        }
        const message = err instanceof Error ? err.message : 'Failed to resolve PR head.'
        setResolveError(message)
        setResolving(false)
      }
    },
    [onClose, onSelect, repoId]
  )

  const handleDefaultSelect = useCallback(() => {
    onSelect({ kind: 'default' })
    onClose()
  }, [onClose, onSelect])

  const visiblePrItems = useMemo(() => {
    if (normalizedPrQuery.directNumber !== null) {
      return directPrItem ? [directPrItem] : []
    }
    return prItems ?? []
  }, [directPrItem, normalizedPrQuery.directNumber, prItems])

  return (
    <div className="flex w-[420px] flex-col overflow-hidden">
      <Tabs value={tab} onValueChange={(v) => setTab(v as PickerTab)} className="gap-0">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
          <TabsList className="h-8">
            <TabsTrigger value="branches" className="gap-1.5 text-xs">
              <GitBranch className="size-3.5" />
              Branches
            </TabsTrigger>
            <TabsTrigger
              value="prs"
              disabled={isRemoteRepo}
              className="gap-1.5 text-xs"
              title={
                isRemoteRepo ? 'PR start points not supported for remote repos yet' : undefined
              }
            >
              <GitPullRequest className="size-3.5" />
              Pull requests
            </TabsTrigger>
          </TabsList>
          {currentBaseBranch !== undefined ? (
            <button
              type="button"
              onClick={handleDefaultSelect}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Use default
            </button>
          ) : null}
        </div>

        <div className="px-3 pt-2 pb-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'branches' ? 'Search branches…' : 'Search PRs, paste #N or URL…'}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        {resolveError ? (
          <div className="mx-3 mb-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            {resolveError}
          </div>
        ) : null}

        <TabsContent value="branches" className="px-1 pb-2">
          <div className="max-h-72 overflow-y-auto">
            {branchesLoading && branches.length === 0 ? (
              <PickerLoadingRows />
            ) : branches.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {query.trim() ? 'No branches match' : 'No branches found'}
              </div>
            ) : (
              branches.map((refName) => (
                <BranchRow
                  key={refName}
                  refName={refName}
                  active={refName === currentBaseBranch}
                  onSelect={() => handleBranchSelect(refName)}
                />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="prs" className="px-1 pb-2">
          <div className="max-h-72 overflow-y-auto">
            {isRemoteRepo ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                PR start points aren&apos;t supported for remote repos yet.
              </div>
            ) : normalizedPrQuery.repoMismatch && normalizedPrQuery.directNumber === null ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                URL targets a different repo; searching by text instead.
              </div>
            ) : prsError ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {prsError.includes('gh') ? 'gh not available — Branches tab still works' : prsError}
              </div>
            ) : (prsLoading || directLoading) && visiblePrItems.length === 0 ? (
              <PickerLoadingRows />
            ) : visiblePrItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {normalizedPrQuery.directNumber !== null
                  ? `No open PR #${normalizedPrQuery.directNumber}`
                  : 'No open PRs'}
              </div>
            ) : (
              visiblePrItems.map((item) => (
                <PrRow
                  key={`${item.type}-${item.number}`}
                  item={item}
                  disabled={resolving}
                  onSelect={() => void handlePrSelect(item)}
                />
              ))
            )}
            {resolving ? (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" />
                Resolving PR head…
              </div>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function PickerLoadingRows(): React.JSX.Element {
  return (
    <div className="space-y-1 px-2 py-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-muted/40" />
      ))}
    </div>
  )
}

function BranchRow({
  refName,
  active,
  onSelect
}: {
  refName: string
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition hover:bg-muted/60',
        active && 'bg-accent text-accent-foreground'
      )}
    >
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono">{refName}</span>
    </button>
  )
}

function PrRow({
  item,
  disabled,
  onSelect
}: {
  item: GitHubWorkItem
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const isFork = item.isCrossRepository === true
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition hover:bg-muted/60',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent'
      )}
      title={isFork ? 'Fork PR — will branch from a snapshot of the PR head' : undefined}
    >
      <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">#{item.number}</span>
          <span className="truncate">{item.title}</span>
        </span>
        {item.branchName ? (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
            {item.branchName}
            {isFork ? ' · fork' : ''}
          </span>
        ) : null}
      </span>
    </button>
  )
}
