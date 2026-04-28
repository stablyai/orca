/* eslint-disable max-lines -- Why: this tab co-locates GitHub PR/issue/branch
and Linear sub-tabs + their fetch/resolve/launch plumbing so the "Create from…"
entry point lives in one file. Splitting would scatter debounce/caching logic
that only these sub-tabs use. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  CircleDot,
  CornerDownLeft,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Search
} from 'lucide-react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import RepoCombobox from '@/components/repo/RepoCombobox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { normalizeGitHubLinkQuery } from '@/lib/github-links'
import type { RepoSlug } from '@/lib/github-links'
import { launchWorkItemDirect, launchFromBranch } from '@/lib/launch-work-item-direct'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { GitHubWorkItem, LinearIssue } from '../../../../shared/types'

export type CreateFromSubTab = 'prs' | 'issues' | 'branches' | 'linear'

type CreateFromTabProps = {
  /** Invoked after a successful workspace launch so the parent can close the
   *  dialog. */
  onLaunched: () => void
  /** Called when any code path needs to fall back to the Quick-tab composer
   *  (setup policy = 'ask', or the launch failed mid-flight). The parent is
   *  responsible for switching tabs and prefilling whatever context is
   *  available (linked work item, base branch, etc.). */
  onFallbackToQuick: (data: {
    initialRepoId?: string
    linkedWorkItem?: {
      type: 'issue' | 'pr'
      number: number
      title: string
      url: string
    } | null
    prefilledName?: string
    initialBaseBranch?: string
  }) => void
  /** Whether this tab is currently visible. Used by effects that should only
   *  run while the user can actually see the results (fetching, autoFocus). */
  active?: boolean
}

const SUB_TABS: {
  id: CreateFromSubTab
  label: string
  Icon: React.ComponentType<{ className?: string }>
}[] = [
  { id: 'prs', label: 'Pull requests', Icon: GitPullRequest },
  { id: 'issues', label: 'Issues', Icon: CircleDot },
  { id: 'branches', label: 'Branches', Icon: GitBranch },
  {
    id: 'linear',
    label: 'Linear',
    Icon: ({ className }: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
        <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
      </svg>
    )
  }
]

const PR_LIST_LIMIT = 36
const ISSUE_LIST_LIMIT = 36
const LINEAR_LIST_LIMIT = 36
const SEARCH_DEBOUNCE_MS = 200

export default function CreateFromTab({
  onLaunched,
  onFallbackToQuick,
  active = true
}: CreateFromTabProps): React.JSX.Element {
  const {
    activeRepoId,
    repos,
    linearStatus,
    listLinearIssues,
    searchLinearIssues,
    rememberedSubTab,
    setRememberedSubTab
  } = useAppStore(
    useShallow((s) => ({
      activeRepoId: s.activeRepoId,
      repos: s.repos,
      linearStatus: s.linearStatus,
      listLinearIssues: s.listLinearIssues,
      searchLinearIssues: s.searchLinearIssues,
      rememberedSubTab: s.createFromSubTab,
      setRememberedSubTab: s.setCreateFromSubTab
    }))
  )

  const eligibleRepos = useMemo(() => repos.filter((r) => isGitRepoKind(r)), [repos])

  // Why: seed from the remembered sub-tab so users returning to Create-from
  // land on whichever source they worked from last (GitHub Issues, Linear,
  // …). A writer-through setter keeps the store in sync whenever the user
  // switches, which persists across composer closes within the same session.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const subTabsListRef = useRef<HTMLDivElement | null>(null)
  const [subTab, setSubTabLocal] = useState<CreateFromSubTab>(rememberedSubTab)
  // Why: results live in a popover anchored to the search input so the
  // dialog stays compact while the list sizes to content and can show
  // async-loading skeletons without reserving a 320px block inside the
  // modal. The popover opens as soon as the input is focused so users
  // see their options immediately — opening only on keystroke felt
  // unresponsive given this flow starts by clicking the field.
  const [resultsOpen, setResultsOpen] = useState(false)
  // Why: the results popover auto-opens on focus, but clicking a sub-tab
  // pulls focus away from the search input and Radix closes the popover
  // on the pointer-down. Re-open on sub-tab change so the new sub-tab's
  // results appear immediately rather than forcing the user to click the
  // input again; also refocus the input so typing continues the flow.
  const setSubTab = useCallback(
    (next: CreateFromSubTab) => {
      setSubTabLocal(next)
      setRememberedSubTab(next)
      setResultsOpen(true)
      // Why: preemptively flip the new sub-tab's loading flag so the single
      // render between sub-tab change and the fetch effect doesn't flash
      // "No open PRs / No issues / …" while stale state from the previous
      // sub-tab still claims nothing is loading. The fetch effect sets the
      // flag to true again on mount, then to false when data resolves — so
      // this just patches the one-frame gap.
      if (next === 'prs') {
        setPrLoading(true)
      } else if (next === 'issues') {
        setIssueLoading(true)
      } else if (next === 'branches') {
        setBranchesLoading(true)
      } else if (next === 'linear') {
        setLinearLoading(true)
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus({ preventScroll: true })
      })
    },
    [setRememberedSubTab]
  )
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedRepoId, setSelectedRepoId] = useState<string>(() => {
    if (activeRepoId && eligibleRepos.some((r) => r.id === activeRepoId)) {
      return activeRepoId
    }
    return eligibleRepos[0]?.id ?? ''
  })

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // Why: auto-focus the search input when this tab becomes visible — but
  // only when it's actually visible AND the parent tab-panel height
  // transition has settled. Without the `active` guard, the
  // AnimatedTabPanels wrapper (which keeps both panels mounted for
  // state-preservation) would let the search field steal focus from the
  // Quick tab's repo combobox on modal open. The transition-settle delay
  // matters because focusing the input fires onFocus → setResultsOpen(true)
  // → Popover positions against the anchor. If the anchor is still moving
  // (AnimatedTabPanels animates the wrapper height over ~200ms), Radix
  // anchors the popover mid-flight and it visibly drifts down as the
  // layout settles. Waiting past the transition lets Radix place it
  // against the final input position from the start.
  useEffect(() => {
    if (!active) {
      return
    }
    const el = searchInputRef.current
    if (!el) {
      return
    }
    const timer = window.setTimeout(() => el.focus({ preventScroll: true }), 220)
    return () => window.clearTimeout(timer)
  }, [active])

  // Why: the results popover is portaled outside this panel, so switching
  // to the Quick tab (via click or the ⌘N hotkey) doesn't unmount or hide
  // it — users would see the CreateFrom dropdown floating over the Quick
  // tab. Force-close when this tab goes inactive.
  useEffect(() => {
    if (!active) {
      setResultsOpen(false)
    }
  }, [active])

  const selectedRepo = useMemo(
    () => eligibleRepos.find((r) => r.id === selectedRepoId) ?? null,
    [eligibleRepos, selectedRepoId]
  )
  const isRemoteRepo = Boolean(selectedRepo?.connectionId)

  // Why: resolve the repo slug once so normalizeGitHubLinkQuery can detect
  // pasted URLs that target a different repo than the selected one — same
  // treatment StartFromPicker applies, so the "paste a URL" flow feels
  // identical between the two surfaces.
  const [repoSlug, setRepoSlug] = useState<RepoSlug | null>(null)
  useEffect(() => {
    if (!selectedRepo?.path) {
      setRepoSlug(null)
      return
    }
    let stale = false
    void window.api.gh
      .repoSlug({ repoPath: selectedRepo.path })
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
  }, [selectedRepo?.path])

  const normalizedGhQuery = useMemo(
    () => normalizeGitHubLinkQuery(debouncedQuery, repoSlug),
    [debouncedQuery, repoSlug]
  )

  // ---------------------------------------------------------------------
  // GitHub PRs
  // ---------------------------------------------------------------------
  const [prItems, setPrItems] = useState<GitHubWorkItem[]>([])
  const [prLoading, setPrLoading] = useState(false)
  const [prError, setPrError] = useState<string | null>(null)
  const [directPr, setDirectPr] = useState<GitHubWorkItem | null>(null)

  useEffect(() => {
    if (subTab !== 'prs' || !selectedRepo?.path || isRemoteRepo) {
      return
    }
    if (normalizedGhQuery.directNumber !== null) {
      return // handled by direct-lookup effect below
    }
    const trimmed = debouncedQuery.trim()
    const q =
      trimmed && !normalizedGhQuery.repoMismatch
        ? `is:pr is:open ${normalizedGhQuery.query}`
        : 'is:pr is:open'

    let stale = false
    setPrLoading(true)
    setPrError(null)
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: PR_LIST_LIMIT, query: q })
      .then((items) => {
        if (stale) {
          return
        }
        setPrItems(
          items
            .filter((i) => i.type === 'pr')
            .map((i) => ({ ...i, repoId: selectedRepo.id })) as unknown as GitHubWorkItem[]
        )
        setPrLoading(false)
      })
      .catch((err) => {
        if (stale) {
          return
        }
        setPrError(err instanceof Error ? err.message : 'Failed to load PRs.')
        setPrLoading(false)
      })
    return () => {
      stale = true
    }
  }, [
    subTab,
    selectedRepo?.id,
    selectedRepo?.path,
    isRemoteRepo,
    debouncedQuery,
    normalizedGhQuery.query,
    normalizedGhQuery.repoMismatch,
    normalizedGhQuery.directNumber
  ])

  // ---------------------------------------------------------------------
  // GitHub Issues
  // ---------------------------------------------------------------------
  const [issueItems, setIssueItems] = useState<GitHubWorkItem[]>([])
  const [issueLoading, setIssueLoading] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)

  useEffect(() => {
    if (subTab !== 'issues' || !selectedRepo?.path || isRemoteRepo) {
      return
    }
    if (normalizedGhQuery.directNumber !== null) {
      return
    }
    const trimmed = debouncedQuery.trim()
    const q =
      trimmed && !normalizedGhQuery.repoMismatch
        ? `is:issue is:open ${normalizedGhQuery.query}`
        : 'is:issue is:open'

    let stale = false
    setIssueLoading(true)
    setIssueError(null)
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: ISSUE_LIST_LIMIT, query: q })
      .then((items) => {
        if (stale) {
          return
        }
        setIssueItems(
          items
            .filter((i) => i.type === 'issue')
            .map((i) => ({ ...i, repoId: selectedRepo.id })) as unknown as GitHubWorkItem[]
        )
        setIssueLoading(false)
      })
      .catch((err) => {
        if (stale) {
          return
        }
        setIssueError(err instanceof Error ? err.message : 'Failed to load issues.')
        setIssueLoading(false)
      })
    return () => {
      stale = true
    }
  }, [
    subTab,
    selectedRepo?.id,
    selectedRepo?.path,
    isRemoteRepo,
    debouncedQuery,
    normalizedGhQuery.query,
    normalizedGhQuery.repoMismatch,
    normalizedGhQuery.directNumber
  ])

  // ---------------------------------------------------------------------
  // Direct `#N` / URL lookup across PR + Issue tabs
  // ---------------------------------------------------------------------
  const [directLoading, setDirectLoading] = useState(false)
  useEffect(() => {
    if ((subTab !== 'prs' && subTab !== 'issues') || !selectedRepo?.path || isRemoteRepo) {
      setDirectPr(null)
      return
    }
    const directNumber = normalizedGhQuery.directNumber
    if (directNumber === null) {
      setDirectPr(null)
      return
    }
    let stale = false
    setDirectLoading(true)
    void window.api.gh
      .workItem({ repoPath: selectedRepo.path, number: directNumber })
      .then((item) => {
        if (stale) {
          return
        }
        const gh = item as GitHubWorkItem | null
        if (!gh) {
          setDirectPr(null)
        } else {
          const wantedType = subTab === 'prs' ? 'pr' : 'issue'
          setDirectPr(
            gh.type === wantedType
              ? ({ ...gh, repoId: selectedRepo.id } as unknown as GitHubWorkItem)
              : null
          )
        }
      })
      .catch(() => {
        if (!stale) {
          setDirectPr(null)
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
  }, [subTab, selectedRepo?.id, selectedRepo?.path, isRemoteRepo, normalizedGhQuery.directNumber])

  // ---------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  useEffect(() => {
    if (subTab !== 'branches' || !selectedRepo) {
      return
    }
    const trimmed = debouncedQuery.trim()
    let stale = false
    setBranchesLoading(true)
    void window.api.repos
      .searchBaseRefs({ repoId: selectedRepo.id, query: trimmed, limit: 30 })
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
  }, [subTab, selectedRepo, debouncedQuery])

  // ---------------------------------------------------------------------
  // Linear
  // ---------------------------------------------------------------------
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearError, setLinearError] = useState<string | null>(null)
  useEffect(() => {
    if (subTab !== 'linear' || !linearStatus.connected) {
      return
    }
    let stale = false
    setLinearLoading(true)
    setLinearError(null)
    const trimmed = debouncedQuery.trim()
    const request = trimmed
      ? searchLinearIssues(trimmed, LINEAR_LIST_LIMIT)
      : listLinearIssues('assigned', LINEAR_LIST_LIMIT)
    void request
      .then((items) => {
        if (!stale) {
          setLinearIssues(items)
          setLinearLoading(false)
        }
      })
      .catch((err) => {
        if (!stale) {
          setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
          setLinearLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // Why: list/search methods are stable store selectors; depending on them
    // would re-run the effect on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, linearStatus.connected, debouncedQuery])

  // ---------------------------------------------------------------------
  // Selection handlers — each defers to launchWorkItemDirect / launchFromBranch
  // and falls back to the Quick tab on policy=ask.
  // ---------------------------------------------------------------------
  // Why: a single in-flight token guards against double-clicks and tab
  // switches racing with slow network calls (PR base-ref resolution can take
  // multiple seconds on cold caches).
  const inflightRef = useRef(0)
  const [launching, setLaunching] = useState(false)
  // Why: once the user selects a row the popover closes and the search input
  // would otherwise fall back to the (often empty) query, making the field
  // look blank while "Creating workspace…" shows below. Pin the selected
  // row's label into the input for the duration of the launch so the user
  // still sees what they picked.
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const beginLaunch = useCallback((label: string) => {
    setSelectedLabel(label)
    setResultsOpen(false)
  }, [])

  const handlePrSelect = useCallback(
    async (item: GitHubWorkItem) => {
      if (!selectedRepo || item.type !== 'pr') {
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      beginLaunch(`#${item.number} ${item.title}`)
      try {
        const result = await window.api.worktrees.resolvePrBase({
          repoId: selectedRepo.id,
          prNumber: item.number,
          ...(item.branchName ? { headRefName: item.branchName } : {}),
          ...(item.isCrossRepository !== undefined
            ? { isCrossRepository: item.isCrossRepository }
            : {})
        })
        if (token !== inflightRef.current) {
          return
        }
        if ('error' in result) {
          // Why: failed head resolution still gives the user something to do —
          // hand off to Quick with the linked PR so they can pick a different
          // base branch manually instead of being stuck on this tab.
          onFallbackToQuick({
            initialRepoId: selectedRepo.id,
            linkedWorkItem: {
              type: 'pr',
              number: item.number,
              title: item.title,
              url: item.url
            },
            prefilledName: item.title
          })
          return
        }
        await launchWorkItemDirect({
          item: {
            title: item.title,
            url: item.url,
            type: 'pr',
            number: item.number
          },
          repoId: selectedRepo.id,
          baseBranch: result.baseBranch,
          openModalFallback: () =>
            onFallbackToQuick({
              initialRepoId: selectedRepo.id,
              linkedWorkItem: {
                type: 'pr',
                number: item.number,
                title: item.title,
                url: item.url
              },
              prefilledName: item.title,
              initialBaseBranch: result.baseBranch
            })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
          setSelectedLabel(null)
        }
      }
    },
    [beginLaunch, onFallbackToQuick, onLaunched, selectedRepo]
  )

  const handleIssueSelect = useCallback(
    async (item: GitHubWorkItem) => {
      if (!selectedRepo || item.type !== 'issue') {
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      beginLaunch(`#${item.number} ${item.title}`)
      try {
        await launchWorkItemDirect({
          item: {
            title: item.title,
            url: item.url,
            type: 'issue',
            number: item.number
          },
          repoId: selectedRepo.id,
          openModalFallback: () =>
            onFallbackToQuick({
              initialRepoId: selectedRepo.id,
              linkedWorkItem: {
                type: 'issue',
                number: item.number,
                title: item.title,
                url: item.url
              },
              prefilledName: item.title
            })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
          setSelectedLabel(null)
        }
      }
    },
    [beginLaunch, onFallbackToQuick, onLaunched, selectedRepo]
  )

  const handleBranchSelect = useCallback(
    async (refName: string) => {
      if (!selectedRepo) {
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      beginLaunch(refName)
      try {
        await launchFromBranch({
          repoId: selectedRepo.id,
          baseBranch: refName,
          openModalFallback: () => onFallbackToQuick({ initialRepoId: selectedRepo.id })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
          setSelectedLabel(null)
        }
      }
    },
    [beginLaunch, onFallbackToQuick, onLaunched, selectedRepo]
  )

  const handleLinearSelect = useCallback(
    async (issue: LinearIssue) => {
      // Why: Linear issues aren't scoped to a git repo, so pick the active
      // repo (or the first eligible) as a target for the worktree. Users can
      // still override via the Quick tab fallback if setup policy is `ask`.
      const repoForLaunch =
        eligibleRepos.find((r) => r.id === selectedRepoId) ?? eligibleRepos[0] ?? null
      if (!repoForLaunch) {
        onFallbackToQuick({})
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      beginLaunch(`${issue.identifier} ${issue.title}`)
      try {
        const parts = [
          `[${issue.identifier}] ${issue.title}`,
          `Status: ${issue.state.name} · Team: ${issue.team.name}`,
          issue.assignee ? `Assignee: ${issue.assignee.displayName}` : null,
          issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : null,
          `URL: ${issue.url}`,
          issue.description ? `\n${issue.description}` : null
        ]
        const pasteContent = parts.filter(Boolean).join('\n')
        await launchWorkItemDirect({
          item: {
            title: issue.title,
            url: issue.url,
            type: 'issue',
            number: null,
            pasteContent,
            linearIdentifier: issue.identifier
          },
          repoId: repoForLaunch.id,
          openModalFallback: () =>
            onFallbackToQuick({
              initialRepoId: repoForLaunch.id,
              linkedWorkItem: {
                type: 'issue',
                // Why: Linear identifiers are strings (e.g. "ENG-123") — use 0
                // as a placeholder since the URL is what the agent acts on.
                number: 0,
                title: issue.title,
                url: issue.url
              },
              prefilledName: issue.title
            })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
          setSelectedLabel(null)
        }
      }
    },
    [beginLaunch, eligibleRepos, onFallbackToQuick, onLaunched, selectedRepoId]
  )

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const visiblePrItems = useMemo(() => {
    if (normalizedGhQuery.directNumber !== null) {
      return directPr && directPr.type === 'pr' ? [directPr] : []
    }
    return prItems
  }, [directPr, normalizedGhQuery.directNumber, prItems])
  const visibleIssueItems = useMemo(() => {
    if (normalizedGhQuery.directNumber !== null) {
      return directPr && directPr.type === 'issue' ? [directPr] : []
    }
    return issueItems
  }, [directPr, normalizedGhQuery.directNumber, issueItems])

  const placeholderBySubTab: Record<CreateFromSubTab, string> = {
    prs: 'Search PRs, paste #N or URL…',
    issues: 'Search issues, paste #N or URL…',
    branches: 'Search branches…',
    linear: 'Search Linear issues…'
  }

  const showGhRepoPicker = subTab !== 'linear'

  // Why: each row gets a stable, unique `value` so cmdk's keyboard
  // navigation can track selection across sub-tab changes. Values also
  // feed the controlled `commandValue` state below.
  type RowEntry =
    | { kind: 'pr'; value: string; item: GitHubWorkItem }
    | { kind: 'issue'; value: string; item: GitHubWorkItem }
    | { kind: 'branch'; value: string; refName: string }
    | { kind: 'linear'; value: string; issue: LinearIssue }

  type ResultState =
    | { kind: 'empty'; message: React.ReactNode }
    | { kind: 'loading' }
    | { kind: 'rows'; rows: RowEntry[] }

  const resultState = useMemo<ResultState>(() => {
    if (subTab === 'prs') {
      if (isRemoteRepo) {
        return { kind: 'empty', message: "PR start points aren't supported for remote repos yet." }
      }
      if (normalizedGhQuery.repoMismatch && normalizedGhQuery.directNumber === null) {
        return {
          kind: 'empty',
          message: `URL targets ${normalizedGhQuery.repoMismatch}, not the selected repo.`
        }
      }
      if (prError) {
        return {
          kind: 'empty',
          message: prError.includes('gh') ? 'gh not available — Branches tab still works' : prError
        }
      }
      if ((prLoading || directLoading) && visiblePrItems.length === 0) {
        return { kind: 'loading' }
      }
      if (visiblePrItems.length === 0) {
        return {
          kind: 'empty',
          message:
            normalizedGhQuery.directNumber !== null
              ? `No PR #${normalizedGhQuery.directNumber}`
              : 'No open PRs'
        }
      }
      return {
        kind: 'rows',
        rows: visiblePrItems.map((item) => ({
          kind: 'pr' as const,
          value: `pr-${item.number}`,
          item
        }))
      }
    }
    if (subTab === 'issues') {
      if (isRemoteRepo) {
        return {
          kind: 'empty',
          message: "Issue start points aren't supported for remote repos yet."
        }
      }
      if (normalizedGhQuery.repoMismatch && normalizedGhQuery.directNumber === null) {
        return {
          kind: 'empty',
          message: `URL targets ${normalizedGhQuery.repoMismatch}, not the selected repo.`
        }
      }
      if (issueError) {
        return {
          kind: 'empty',
          message: issueError.includes('gh')
            ? 'gh not available — Branches tab still works'
            : issueError
        }
      }
      if ((issueLoading || directLoading) && visibleIssueItems.length === 0) {
        return { kind: 'loading' }
      }
      if (visibleIssueItems.length === 0) {
        return {
          kind: 'empty',
          message:
            normalizedGhQuery.directNumber !== null
              ? `No issue #${normalizedGhQuery.directNumber}`
              : 'No open issues'
        }
      }
      return {
        kind: 'rows',
        rows: visibleIssueItems.map((item) => ({
          kind: 'issue' as const,
          value: `issue-${item.number}`,
          item
        }))
      }
    }
    if (subTab === 'branches') {
      if (branchesLoading && branches.length === 0) {
        return { kind: 'loading' }
      }
      if (branches.length === 0) {
        return {
          kind: 'empty',
          message: query.trim() ? 'No branches match' : 'No branches found'
        }
      }
      return {
        kind: 'rows',
        rows: branches.map((refName) => ({
          kind: 'branch' as const,
          value: `branch-${refName}`,
          refName
        }))
      }
    }
    // linear
    if (!linearStatus.connected) {
      return {
        kind: 'empty',
        message:
          'Connect Linear from Settings → Integrations to create workspaces from Linear issues.'
      }
    }
    if (linearError) {
      return { kind: 'empty', message: linearError }
    }
    if (linearLoading && linearIssues.length === 0) {
      return { kind: 'loading' }
    }
    if (linearIssues.length === 0) {
      return {
        kind: 'empty',
        message: query.trim() ? 'No Linear issues match' : 'No Linear issues assigned to you'
      }
    }
    return {
      kind: 'rows',
      rows: linearIssues.map((issue) => ({
        kind: 'linear' as const,
        value: `linear-${issue.id}`,
        issue
      }))
    }
  }, [
    branches,
    branchesLoading,
    directLoading,
    isRemoteRepo,
    issueError,
    issueLoading,
    linearError,
    linearIssues,
    linearLoading,
    linearStatus.connected,
    normalizedGhQuery.directNumber,
    normalizedGhQuery.repoMismatch,
    prError,
    prLoading,
    query,
    subTab,
    visibleIssueItems,
    visiblePrItems
  ])

  const handleRowSelect = useCallback(
    (row: RowEntry) => {
      if (row.kind === 'pr') {
        void handlePrSelect(row.item)
      } else if (row.kind === 'issue') {
        void handleIssueSelect(row.item)
      } else if (row.kind === 'branch') {
        void handleBranchSelect(row.refName)
      } else {
        void handleLinearSelect(row.issue)
      }
    },
    [handleBranchSelect, handleIssueSelect, handleLinearSelect, handlePrSelect]
  )

  // Why: cmdk tracks the highlighted row via a controlled `value`. We
  // seed it to the first row on list change so Enter works immediately
  // and the top row has the visible selected style — matching every
  // shadcn combobox flow.
  const [commandValue, setCommandValue] = useState<string>('')
  useEffect(() => {
    if (resultState.kind === 'rows' && resultState.rows.length > 0) {
      setCommandValue((prev) =>
        resultState.rows.some((r) => r.value === prev) ? prev : resultState.rows[0].value
      )
    }
  }, [resultState])

  return (
    <div className="flex flex-col gap-3">
      {/* Why: give the Repository selector a stable row above the tabs so
          switching to Linear (which hides the picker) doesn't rearrange the
          sub-tab row, and the sub-tabs get the full width for themselves.
          Matches the field-label style used on the Quick tab so the two
          surfaces feel like the same form dialect.

          The grid-template-rows 0fr↔1fr trick animates the picker's
          collapse/expand smoothly when the user moves between Linear (no
          repo picker) and GH sub-tabs. We keep the DOM mounted across the
          transition so focus/state inside the combobox survives, and clip
          the overflow so the shrinking row never peeks past the borders. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
          showGhRepoPicker ? 'grid-rows-[1fr] opacity-100' : '-mt-3 grid-rows-[0fr] opacity-0'
        )}
        aria-hidden={!showGhRepoPicker}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Repository</label>
            <RepoCombobox
              repos={eligibleRepos}
              value={selectedRepoId}
              onValueChange={setSelectedRepoId}
              placeholder="Repository"
              triggerClassName="h-8 w-full border-input text-xs"
              showStandaloneAddButton={false}
            />
          </div>
        </div>
      </div>

      <Tabs
        value={subTab}
        onValueChange={(v) => setSubTab(v as CreateFromSubTab)}
        className="gap-0"
      >
        <TabsList
          ref={subTabsListRef}
          variant="line"
          className="h-8 w-full justify-start gap-5 border-b border-border/40 px-0"
        >
          {SUB_TABS.map(({ id, label, Icon }) => (
            <TabsTrigger key={id} value={id} className="flex-none gap-1.5 px-0 text-xs">
              <Icon className="size-3.5" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="pt-3">
          <Popover open={resultsOpen} onOpenChange={setResultsOpen}>
            <Command
              value={commandValue}
              onValueChange={setCommandValue}
              shouldFilter={false}
              // Why: cmdk listens on its root for keyboard nav. Leaving
              // its wrapper as a flex column keeps the input + popover
              // rendering in their natural positions while cmdk still
              // sees the input + list as one logical tree, so arrow
              // keys move the highlighted row and Enter selects it.
              className="overflow-visible bg-transparent"
            >
              <PopoverAnchor asChild>
                <div className="relative">
                  {launching ? (
                    <LoaderCircle className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                  ) : (
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  )}
                  <Input
                    ref={searchInputRef}
                    // Why: once a row is chosen we pin its label into the input
                    // so the user still sees what they selected while the
                    // launch runs. `readOnly` + aria-busy lets keystrokes still
                    // blur/focus without the text being editable mid-launch.
                    value={selectedLabel ?? query}
                    readOnly={launching}
                    aria-busy={launching}
                    onChange={(e) => {
                      if (launching) {
                        return
                      }
                      setQuery(e.target.value)
                      setResultsOpen(true)
                    }}
                    onFocus={() => {
                      if (!launching) {
                        setResultsOpen(true)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (launching) {
                        return
                      }
                      if (e.key === 'Escape' && resultsOpen) {
                        // Why: first Escape dismisses the suggestions; only
                        // if the popover is already closed should Escape
                        // bubble up to close the dialog.
                        e.stopPropagation()
                        setResultsOpen(false)
                        return
                      }
                      if (
                        e.key === 'ArrowDown' ||
                        e.key === 'ArrowUp' ||
                        e.key === 'Home' ||
                        e.key === 'End'
                      ) {
                        if (!resultsOpen) {
                          setResultsOpen(true)
                        }
                        // Why: cmdk handles arrow/Home/End on its root via
                        // its own listener. The event reaching here already
                        // got processed; just make sure the popover is open
                        // so the user sees the movement.
                      }
                      if (e.key === 'Enter' && resultsOpen && resultState.kind === 'rows') {
                        const row = resultState.rows.find((r) => r.value === commandValue)
                        if (row) {
                          e.preventDefault()
                          handleRowSelect(row)
                        }
                      }
                    }}
                    placeholder={placeholderBySubTab[subTab]}
                    className="h-9 pl-8 text-sm"
                  />
                </div>
              </PopoverAnchor>
              <PopoverContent
                align="start"
                sideOffset={4}
                // Why: match the anchor width so results feel "attached"
                // to the input. `--radix-popover-content-available-height`
                // is Radix's dynamic measurement of free space on the
                // chosen side (capped by the viewport); clamping the
                // popover max-height to it lets the list grow as tall as
                // it can without spilling outside the viewport whether
                // the popover opens downward or flips upward.
                //
                // `popover-scroll-content` pairs with the wheel-event
                // handler on PopoverContent so wheel scroll works even
                // though Radix Dialog applies react-remove-scroll to
                // everything outside its own subtree. The CommandList
                // child uses h-full + overflow-y-auto so it owns the
                // scroll region — nesting it this way means the
                // shadcn-style `scrollbar-sleek` track lives inside the
                // popover's rounded border.
                className="popover-scroll-content flex w-[var(--radix-popover-trigger-width)] flex-col p-0"
                style={{
                  maxHeight: 'min(var(--radix-popover-content-available-height,22rem),22rem)'
                }}
                onOpenAutoFocus={(event) => {
                  // Why: the input keeps focus so typing continues to
                  // filter results. Without preventDefault the popover
                  // would pull focus to its first child on open.
                  event.preventDefault()
                }}
                onPointerDownOutside={(event) => {
                  // Why: the search input is the popover's anchor (not its
                  // trigger), so Radix treats clicks on it as "outside" and
                  // would close the popover. Sub-tab triggers are also
                  // outside — clicking them should just switch source and
                  // keep results visible rather than dismissing the list.
                  const target = event.target as Node
                  if (
                    searchInputRef.current?.contains(target) ||
                    subTabsListRef.current?.contains(target)
                  ) {
                    event.preventDefault()
                  }
                }}
                onFocusOutside={(event) => {
                  // Why: sub-tab clicks move focus to a tab trigger and we
                  // refocus the search input on the next frame. Both of
                  // those focus destinations are "outside" the popover
                  // content — if we don't suppress them Radix dismisses the
                  // list and the user has to click the input again to see
                  // the new sub-tab's results.
                  const target = event.target as Node
                  if (
                    searchInputRef.current?.contains(target) ||
                    subTabsListRef.current?.contains(target)
                  ) {
                    event.preventDefault()
                  }
                }}
              >
                <CommandList className="!max-h-none min-h-0 flex-1 scrollbar-sleek">
                  {resultState.kind === 'loading' ? (
                    <LoadingRows />
                  ) : resultState.kind === 'empty' ? (
                    <EmptyMessage>{resultState.message}</EmptyMessage>
                  ) : (
                    <CommandGroup className="p-1">
                      {resultState.rows.map((row) => (
                        <CommandItem
                          key={row.value}
                          value={row.value}
                          onSelect={() => handleRowSelect(row)}
                          disabled={launching}
                          className="group gap-2 px-2 py-1.5 text-xs data-[disabled=true]:opacity-60"
                        >
                          {row.kind === 'pr' ? (
                            <PrItemContent item={row.item} />
                          ) : row.kind === 'issue' ? (
                            <IssueItemContent item={row.item} />
                          ) : row.kind === 'branch' ? (
                            <BranchItemContent refName={row.refName} />
                          ) : (
                            <LinearItemContent issue={row.issue} />
                          )}
                          <CornerDownLeft className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 group-data-[selected=true]:opacity-100" />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </PopoverContent>
            </Command>
          </Popover>
        </div>
      </Tabs>

      {launching ? (
        <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          Creating workspace…
        </div>
      ) : null}
    </div>
  )
}

function LoadingRows(): React.JSX.Element {
  return (
    <div className="space-y-1 p-1">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-muted/40" />
      ))}
    </div>
  )
}

function EmptyMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-6 py-6 text-center text-xs text-muted-foreground">{children}</div>
}

function PrItemContent({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  const isFork = item.isCrossRepository === true
  return (
    <>
      <GitPullRequest className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
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
    </>
  )
}

function IssueItemContent({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  return (
    <>
      <CircleDot className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">#{item.number}</span>
          <span className="truncate">{item.title}</span>
        </span>
        {item.author ? (
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {item.author}
          </span>
        ) : null}
      </span>
    </>
  )
}

function BranchItemContent({ refName }: { refName: string }): React.JSX.Element {
  return (
    <>
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono">{refName}</span>
    </>
  )
}

function LinearItemContent({ issue }: { issue: LinearIssue }): React.JSX.Element {
  return (
    <>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {issue.identifier}
      </span>
      <span className="min-w-0 flex-1">
        <span className="truncate">{issue.title}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
          {issue.state.name}
          {issue.team.name ? ` · ${issue.team.name}` : ''}
        </span>
      </span>
    </>
  )
}
