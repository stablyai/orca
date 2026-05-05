/* eslint-disable max-lines -- Why: the smart name field owns source tabs,
search orchestration, and result rendering so the unified create flow stays
in one predictable form control instead of splitting state across fragments. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaseSensitive,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Github,
  LoaderCircle,
  Search,
  Sparkles,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import {
  normalizeGitHubLinkQuery,
  parseGitHubIssueOrPRLink,
  type RepoSlug
} from '@/lib/github-links'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem, LinearIssue } from '../../../../shared/types'

type SmartNameMode = 'smart' | 'github' | 'branches' | 'linear' | 'text'

type RepoOption = ReturnType<typeof useAppStore.getState>['repos'][number]

type SmartWorkspaceNameFieldProps = {
  repos: RepoOption[]
  repoId: string
  onRepoChange: (repoId: string) => void
  value: string
  onValueChange: (value: string) => void
  onGitHubItemSelect: (item: GitHubWorkItem) => void
  onBranchSelect: (refName: string) => void
  onLinearIssueSelect: (issue: LinearIssue) => void
  selectedSource: SmartWorkspaceNameSelection | null
  onClearSelectedSource: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  onPlainEnter?: () => void
}

export type SmartWorkspaceNameSelection = {
  kind: 'github-pr' | 'github-issue' | 'branch' | 'linear'
  label: string
  url?: string
}

const SEARCH_DEBOUNCE_MS = 200
const RESULT_LIMIT = 12

const MODES: {
  id: SmartNameMode
  label: string
  Icon: React.ComponentType<{ className?: string }>
}[] = [
  { id: 'smart', label: 'Smart', Icon: Sparkles },
  { id: 'github', label: 'GitHub', Icon: Github },
  { id: 'branches', label: 'Branch', Icon: GitBranch },
  {
    id: 'linear',
    label: 'Linear',
    Icon: ({ className }: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
        <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
      </svg>
    )
  },
  { id: 'text', label: 'Name', Icon: CaseSensitive }
]

type RowEntry =
  | { kind: 'use-name'; value: string; name: string }
  | { kind: 'github'; value: string; item: GitHubWorkItem }
  | { kind: 'branch'; value: string; refName: string }
  | { kind: 'linear'; value: string; issue: LinearIssue }

export default function SmartWorkspaceNameField({
  repos,
  repoId,
  onRepoChange,
  value,
  onValueChange,
  onGitHubItemSelect,
  onBranchSelect,
  onLinearIssueSelect,
  selectedSource,
  onClearSelectedSource,
  inputRef,
  onPlainEnter
}: SmartWorkspaceNameFieldProps): React.JSX.Element {
  const {
    addRepo,
    fetchWorkItems,
    getCachedWorkItems,
    linearStatus,
    listLinearIssues,
    searchLinearIssues
  } = useAppStore(
    useShallow((s) => ({
      addRepo: s.addRepo,
      fetchWorkItems: s.fetchWorkItems,
      getCachedWorkItems: s.getCachedWorkItems,
      linearStatus: s.linearStatus,
      listLinearIssues: s.listLinearIssues,
      searchLinearIssues: s.searchLinearIssues
    }))
  )

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === repoId) ?? null,
    [repoId, repos]
  )
  const [mode, setMode] = useState<SmartNameMode>('smart')
  const [open, setOpen] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(value)
  const [githubItems, setGithubItems] = useState<GitHubWorkItem[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [githubLoading, setGithubLoading] = useState(false)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [linearLoading, setLinearLoading] = useState(false)
  const [commandValue, setCommandValue] = useState('')
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const tabsListRef = useRef<HTMLDivElement | null>(null)
  const repoSlugCacheRef = useRef<Map<string, RepoSlug | null>>(new Map())
  const handledCrossRepoUrlRef = useRef<string | null>(null)
  const [crossRepoPrompt, setCrossRepoPrompt] = useState<{
    link: NonNullable<ReturnType<typeof parseGitHubIssueOrPRLink>>
    matchingRepo: RepoOption | null
  } | null>(null)

  const setInputNode = useCallback(
    (node: HTMLInputElement | null) => {
      localInputRef.current = node
      if (inputRef) {
        inputRef.current = node
      }
    },
    [inputRef]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(value), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [value])

  useEffect(() => {
    if (selectedSource) {
      setOpen(false)
    }
  }, [selectedSource])

  const normalizedGhQuery = useMemo(
    () => normalizeGitHubLinkQuery(debouncedQuery),
    [debouncedQuery]
  )
  const parsedGhLink = useMemo(() => parseGitHubIssueOrPRLink(debouncedQuery), [debouncedQuery])
  const shouldQueryGithub = mode === 'smart' || mode === 'github'
  const shouldQueryBranches = mode === 'smart' || mode === 'branches'
  const shouldQueryLinear = mode === 'smart' || mode === 'linear'

  useEffect(() => {
    if (!shouldQueryGithub || !selectedRepo?.path || selectedRepo.connectionId) {
      setGithubItems([])
      setGithubLoading(false)
      return
    }
    let stale = false
    const directNumber = normalizedGhQuery.directNumber
    const directLink = parsedGhLink
    if (directLink !== null && handledCrossRepoUrlRef.current !== debouncedQuery.trim()) {
      setGithubLoading(true)
      void getRepoSlugCached(selectedRepo, repoSlugCacheRef.current)
        .then(async (selectedSlug) => {
          if (stale) {
            return
          }
          if (!selectedSlug || sameSlug(selectedSlug, directLink.slug)) {
            handledCrossRepoUrlRef.current = debouncedQuery.trim()
            const item = await window.api.gh.workItemByOwnerRepo({
              repoPath: selectedRepo.path,
              owner: directLink.slug.owner,
              repo: directLink.slug.repo,
              number: directLink.number,
              type: directLink.type
            })
            if (!stale) {
              setGithubItems(item ? [{ ...item, repoId: selectedRepo.id } as GitHubWorkItem] : [])
            }
            return
          }
          const matchingRepo = await findMatchingRepoForSlug(
            repos,
            directLink.slug,
            repoSlugCacheRef.current
          )
          if (!stale) {
            setGithubItems([])
            setOpen(false)
            setCrossRepoPrompt({ link: directLink, matchingRepo })
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
      return () => {
        stale = true
      }
    }
    if (directNumber !== null) {
      setGithubLoading(true)
      const request =
        directLink !== null
          ? window.api.gh.workItemByOwnerRepo({
              repoPath: selectedRepo.path,
              owner: directLink.slug.owner,
              repo: directLink.slug.repo,
              number: directLink.number,
              type: directLink.type
            })
          : window.api.gh.workItem({ repoPath: selectedRepo.path, number: directNumber })
      void request
        .then((item) => {
          if (!stale) {
            setGithubItems(item ? [{ ...item, repoId: selectedRepo.id } as GitHubWorkItem] : [])
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
      return () => {
        stale = true
      }
    }

    const trimmed = normalizedGhQuery.query.trim()
    const query = trimmed ? normalizedGhQuery.query : ''
    const cached = getCachedWorkItems(selectedRepo.path, RESULT_LIMIT, query)
    if (cached) {
      setGithubItems(cached.slice(0, RESULT_LIMIT))
      setGithubLoading(false)
    } else {
      setGithubLoading(true)
    }
    void fetchWorkItems(selectedRepo.id, selectedRepo.path, RESULT_LIMIT, query)
      .then((items) => {
        if (!stale) {
          setGithubItems(items.slice(0, RESULT_LIMIT))
        }
      })
      .catch(() => {
        if (!stale) {
          setGithubItems([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGithubLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    debouncedQuery,
    fetchWorkItems,
    getCachedWorkItems,
    normalizedGhQuery,
    parsedGhLink,
    repos,
    selectedRepo,
    shouldQueryGithub
  ])

  useEffect(() => {
    if (!shouldQueryBranches || !selectedRepo) {
      setBranches([])
      setBranchesLoading(false)
      return
    }
    let stale = false
    setBranchesLoading(true)
    void window.api.repos
      .searchBaseRefs({
        repoId: selectedRepo.id,
        query: debouncedQuery.trim(),
        limit: RESULT_LIMIT
      })
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
  }, [debouncedQuery, selectedRepo, shouldQueryBranches])

  useEffect(() => {
    if (!shouldQueryLinear || !linearStatus.connected) {
      setLinearIssues([])
      setLinearLoading(false)
      return
    }
    let stale = false
    setLinearLoading(true)
    const trimmed = debouncedQuery.trim()
    const request = trimmed
      ? searchLinearIssues(trimmed, RESULT_LIMIT)
      : listLinearIssues('assigned', RESULT_LIMIT)
    void request
      .then((issues) => {
        if (!stale) {
          setLinearIssues(issues)
        }
      })
      .catch(() => {
        if (!stale) {
          setLinearIssues([])
        }
      })
      .finally(() => {
        if (!stale) {
          setLinearLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // Why: list/search actions are stable store methods; depending on them
    // would refetch on unrelated store writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, linearStatus.connected, shouldQueryLinear])

  const rows = useMemo<RowEntry[]>(() => {
    const trimmed = value.trim()
    const nextRows: RowEntry[] = trimmed
      ? [{ kind: 'use-name', value: `use-name-${trimmed}`, name: trimmed }]
      : []
    if (mode === 'text') {
      return nextRows
    }
    if (mode === 'smart' || mode === 'github') {
      nextRows.push(
        ...githubItems.map((item) => ({
          kind: 'github' as const,
          value: `github-${item.type}-${item.number}`,
          item
        }))
      )
    }
    if (mode === 'smart' || mode === 'branches') {
      nextRows.push(
        ...branches.map((refName) => ({
          kind: 'branch' as const,
          value: `branch-${refName}`,
          refName
        }))
      )
    }
    if (mode === 'smart' || mode === 'linear') {
      nextRows.push(
        ...linearIssues.map((issue) => ({
          kind: 'linear' as const,
          value: `linear-${issue.id}`,
          issue
        }))
      )
    }
    return nextRows.slice(0, RESULT_LIMIT + 1)
  }, [branches, githubItems, linearIssues, mode, value])

  useEffect(() => {
    if (rows.length > 0) {
      setCommandValue((current) =>
        rows.some((row) => row.value === current) ? current : rows[0].value
      )
    }
  }, [rows])

  const loading = githubLoading || branchesLoading || linearLoading
  const ActiveInputIcon = mode === 'text' ? CaseSensitive : loading ? LoaderCircle : Search

  const handleSelect = useCallback(
    (row: RowEntry) => {
      if (row.kind === 'use-name') {
        onValueChange(row.name)
      } else if (row.kind === 'github') {
        onGitHubItemSelect(row.item)
      } else if (row.kind === 'branch') {
        onBranchSelect(row.refName)
      } else {
        onLinearIssueSelect(row.issue)
      }
      setOpen(false)
    },
    [onBranchSelect, onGitHubItemSelect, onLinearIssueSelect, onValueChange]
  )

  const acceptGitHubLink = useCallback(
    async (targetRepo: RepoOption): Promise<void> => {
      if (!crossRepoPrompt) {
        return
      }
      handledCrossRepoUrlRef.current = debouncedQuery.trim()
      setGithubLoading(true)
      try {
        const item = await window.api.gh.workItemByOwnerRepo({
          repoPath: targetRepo.path,
          owner: crossRepoPrompt.link.slug.owner,
          repo: crossRepoPrompt.link.slug.repo,
          number: crossRepoPrompt.link.number,
          type: crossRepoPrompt.link.type
        })
        if (!item) {
          return
        }
        onRepoChange(targetRepo.id)
        onGitHubItemSelect({ ...item, repoId: targetRepo.id } as GitHubWorkItem)
        setOpen(false)
        setCrossRepoPrompt(null)
      } finally {
        setGithubLoading(false)
      }
    },
    [crossRepoPrompt, debouncedQuery, onGitHubItemSelect, onRepoChange]
  )

  const handleUseCurrentRepo = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return
    }
    setCrossRepoPrompt(null)
    await acceptGitHubLink(selectedRepo)
  }, [acceptGitHubLink, selectedRepo])

  const handleAddMatchingRepo = useCallback(async (): Promise<void> => {
    if (!crossRepoPrompt) {
      return
    }
    const added = await addRepo()
    if (!added) {
      return
    }
    repoSlugCacheRef.current.delete(added.id)
    const slug = await getRepoSlugCached(added, repoSlugCacheRef.current)
    if (slug && sameSlug(slug, crossRepoPrompt.link.slug)) {
      await acceptGitHubLink(added)
    }
  }, [acceptGitHubLink, addRepo, crossRepoPrompt])

  const dismissCrossRepoPrompt = useCallback((): void => {
    handledCrossRepoUrlRef.current = debouncedQuery.trim()
    setCrossRepoPrompt(null)
  }, [debouncedQuery])

  const placeholder =
    mode === 'smart'
      ? 'Type a name, #1234, branch, GitHub or Linear URL'
      : mode === 'github'
        ? 'Search GitHub PRs and issues'
        : mode === 'branches'
          ? 'Search branches'
          : mode === 'linear'
            ? 'Search Linear issues'
            : 'Workspace name'

  return (
    <div className="min-w-0 space-y-1.5">
      <Tabs
        value={mode}
        onValueChange={(next) => {
          setMode(next as SmartNameMode)
          setOpen(next !== 'text')
          requestAnimationFrame(() => localInputRef.current?.focus({ preventScroll: true }))
        }}
        className="gap-0"
      >
        <TabsList
          ref={tabsListRef}
          variant="line"
          className="h-7 w-full justify-start gap-4 border-b border-border/40 px-0"
        >
          {MODES.map(({ id, label, Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              tabIndex={-1}
              data-smart-name-mode={id}
              className="flex-none gap-1.5 px-0 text-xs"
            >
              <Icon className="size-3.5" />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Popover open={open && mode !== 'text'} onOpenChange={setOpen}>
        <Command
          value={commandValue}
          onValueChange={setCommandValue}
          shouldFilter={false}
          className="overflow-visible bg-transparent"
        >
          <PopoverAnchor asChild>
            <div className="relative min-w-0">
              {selectedSource ? (
                // Why: min-w-0 + w-full lets the pill shrink to its flex
                // parent; without them the inner truncate's intrinsic
                // min-content (long PR title) propagates up and pushes the
                // dialog wider than its max-w.
                <div className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                  <SelectionIcon kind={selectedSource.kind} />
                  <span className="min-w-0 flex-1 truncate font-medium leading-none text-foreground">
                    {selectedSource.label}
                  </span>
                  {selectedSource.url ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void window.api.shell.openUrl(selectedSource.url!)}
                          className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                          aria-label="Open link in browser"
                        >
                          <ExternalLink className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>
                        Open in browser
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={onClearSelectedSource}
                        className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                        aria-label="Clear selected source"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      Clear
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <>
                  <ActiveInputIcon
                    className={cn(
                      'pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground',
                      loading && mode !== 'text' && 'animate-spin'
                    )}
                  />
                  <Input
                    ref={setInputNode}
                    value={value}
                    onChange={(event) => {
                      onValueChange(event.target.value)
                      if (mode !== 'text') {
                        setOpen(true)
                      }
                    }}
                    onFocus={() => {
                      if (mode !== 'text') {
                        setOpen(true)
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Tab' && event.shiftKey) {
                        const activeTrigger = tabsListRef.current?.querySelector<HTMLElement>(
                          `[data-smart-name-mode="${mode}"]`
                        )
                        if (activeTrigger) {
                          event.preventDefault()
                          activeTrigger.focus()
                          return
                        }
                      }
                      if (
                        event.key === 'Enter' &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey
                      ) {
                        if (open && rows.length > 0) {
                          const row = rows.find((entry) => entry.value === commandValue)
                          if (row) {
                            event.preventDefault()
                            handleSelect(row)
                          }
                          return
                        }
                        onPlainEnter?.()
                      }
                      if (event.key === 'Escape' && open) {
                        event.stopPropagation()
                        setOpen(false)
                      }
                    }}
                    placeholder={placeholder}
                    className="h-9 pl-8 text-sm"
                  />
                </>
              )}
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="popover-scroll-content flex w-[var(--radix-popover-trigger-width)] flex-col p-0"
            style={{ maxHeight: 'min(var(--radix-popover-content-available-height,22rem),22rem)' }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              // Why: the input is a PopoverAnchor, not a PopoverTrigger, so
              // Radix treats clicks on it as outside the popover. Keep focus
              // clicks and mode-tab clicks from immediately closing results.
              const target = event.target as Node
              if (
                localInputRef.current?.contains(target) ||
                tabsListRef.current?.contains(target)
              ) {
                event.preventDefault()
              }
            }}
            onFocusOutside={(event) => {
              const target = event.target as Node
              if (
                localInputRef.current?.contains(target) ||
                tabsListRef.current?.contains(target)
              ) {
                event.preventDefault()
              }
            }}
          >
            <CommandList className="!max-h-none min-h-0 flex-1 scrollbar-sleek">
              {loading && rows.length === 0 ? (
                <div className="space-y-1 p-1">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="h-8 animate-pulse rounded bg-muted/40" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {mode === 'linear' && !linearStatus.connected
                    ? 'Connect Linear in Settings to search issues.'
                    : 'Start typing to create a name or find a source.'}
                </div>
              ) : (
                <CommandGroup className="p-1">
                  {rows.map((row) => (
                    <CommandItem
                      key={row.value}
                      value={row.value}
                      onSelect={() => handleSelect(row)}
                      className="gap-2 px-2 py-1.5 text-xs"
                    >
                      <RowIcon row={row} />
                      <RowLabel row={row} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </PopoverContent>
        </Command>
      </Popover>
      <Dialog
        open={crossRepoPrompt !== null}
        onOpenChange={(next) => !next && dismissCrossRepoPrompt()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Switch project?</DialogTitle>
            <DialogDescription>
              The GitHub URL points to {crossRepoPrompt?.link.slug.owner}/
              {crossRepoPrompt?.link.slug.repo}, which is different from the selected project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissCrossRepoPrompt}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => void handleUseCurrentRepo()}>
              Keep {selectedRepo?.displayName ?? 'current project'}
            </Button>
            {crossRepoPrompt?.matchingRepo ? (
              <Button onClick={() => void acceptGitHubLink(crossRepoPrompt.matchingRepo!)}>
                Switch to {crossRepoPrompt.matchingRepo.displayName}
              </Button>
            ) : (
              <Button onClick={() => void handleAddMatchingRepo()}>Add project...</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function RowIcon({ row }: { row: RowEntry }): React.JSX.Element {
  if (row.kind === 'use-name') {
    return <CaseSensitive className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.kind === 'github') {
    return row.item.type === 'pr' ? (
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
    )
  }
  if (row.kind === 'branch') {
    return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return (
    <span className="size-3.5 shrink-0 rounded-sm bg-muted text-[8px] font-semibold leading-3.5 text-muted-foreground">
      L
    </span>
  )
}

function SelectionIcon({ kind }: { kind: SmartWorkspaceNameSelection['kind'] }): React.JSX.Element {
  if (kind === 'github-pr') {
    return <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'github-issue') {
    return <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'branch') {
    return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return (
    <span className="size-3.5 shrink-0 rounded-sm bg-muted text-center text-[8px] font-semibold leading-3.5 text-muted-foreground">
      L
    </span>
  )
}

function RowLabel({ row }: { row: RowEntry }): React.JSX.Element {
  if (row.kind === 'use-name') {
    return (
      <span className="min-w-0 truncate">
        Use <span className="font-medium text-foreground">&ldquo;{row.name}&rdquo;</span> as
        workspace name
      </span>
    )
  }
  if (row.kind === 'github') {
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">#{row.item.number}</span> {row.item.title}
      </span>
    )
  }
  if (row.kind === 'branch') {
    return <span className="min-w-0 truncate font-mono text-[11px]">{row.refName}</span>
  }
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium text-foreground">{row.issue.identifier}</span> {row.issue.title}
    </span>
  )
}

function sameSlug(left: RepoSlug, right: RepoSlug): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  )
}

async function getRepoSlugCached(
  repo: RepoOption,
  cache: Map<string, RepoSlug | null>
): Promise<RepoSlug | null> {
  if (cache.has(repo.id)) {
    return cache.get(repo.id) ?? null
  }
  if (repo.connectionId) {
    cache.set(repo.id, null)
    return null
  }
  try {
    const slug = await window.api.gh.repoSlug({ repoPath: repo.path })
    cache.set(repo.id, slug)
    return slug
  } catch {
    cache.set(repo.id, null)
    return null
  }
}

async function findMatchingRepoForSlug(
  repos: RepoOption[],
  slug: RepoSlug,
  cache: Map<string, RepoSlug | null>
): Promise<RepoOption | null> {
  for (const repo of repos) {
    const candidate = await getRepoSlugCached(repo, cache)
    if (candidate && sameSlug(candidate, slug)) {
      return repo
    }
  }
  return null
}
