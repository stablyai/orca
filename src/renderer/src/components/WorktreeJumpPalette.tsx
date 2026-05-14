/* oxlint-disable max-lines */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Globe, Plus, Server, ServerOff } from 'lucide-react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, useAllWorktrees } from '@/store/selectors'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { branchName } from '@/lib/git-utils'
import { parseGitHubIssueOrPRNumber, parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { sortWorktreesSmart } from '@/components/sidebar/smart-sort'
import { isDefaultBranchWorkspace } from '@/components/sidebar/visible-worktrees'
import { orderEmptyQueryWorktrees } from '@/lib/order-empty-query-worktrees'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { cn } from '@/lib/utils'
import { getWorktreeStatus, getWorktreeStatusLabel } from '@/lib/worktree-status'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  searchWorktrees,
  type MatchRange,
  type PaletteSearchResult
} from '@/lib/worktree-palette-search'
import {
  isBlankBrowserUrl,
  searchBrowserPages,
  type BrowserPaletteSearchResult,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest
} from '@/components/browser-pane/browser-focus'
import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
import { isGitRepoKind } from '../../../shared/repo-kind'

type WorktreePaletteItem = {
  id: string
  type: 'worktree'
  match: PaletteSearchResult
  worktree: Worktree
}

type BrowserPaletteItem = {
  id: string
  type: 'browser-page'
  result: BrowserPaletteSearchResult
}

type SectionHeader = {
  id: string
  type: 'section-header'
  label: string
}

type HintRow = {
  id: string
  type: 'hint'
  label: string
}

type PaletteItem = WorktreePaletteItem | BrowserPaletteItem

type PaletteListEntry = PaletteItem | SectionHeader | HintRow

type BrowserSelection = {
  worktree: Worktree
  workspace: BrowserWorkspace
  page: BrowserPage
}

function HighlightedText({
  text,
  matchRange
}: {
  text: string
  matchRange: MatchRange | null
}): React.JSX.Element {
  if (!matchRange) {
    return <>{text}</>
  }
  const before = text.slice(0, matchRange.start)
  const match = text.slice(matchRange.start, matchRange.end)
  const after = text.slice(matchRange.end)
  return (
    <>
      {before}
      <span className="font-semibold text-foreground">{match}</span>
      {after}
    </>
  )
}

function PaletteState({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function FooterKey({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-foreground/85">
      {children}
    </span>
  )
}

function findBrowserSelection(
  pageId: string,
  workspaceId: string,
  worktreeId: string
): BrowserSelection | null {
  const state = useAppStore.getState()
  const page = (state.browserPagesByWorkspace[workspaceId] ?? []).find((p) => p.id === pageId)
  if (!page) {
    return null
  }
  const workspace = (state.browserTabsByWorktree[worktreeId] ?? []).find(
    (w) => w.id === workspaceId
  )
  if (!workspace) {
    return null
  }
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (!worktree) {
    return null
  }
  return { page, workspace, worktree }
}

export default function WorktreeJumpPalette(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'worktree-palette')
  const closeModal = useAppStore((s) => s.closeModal)
  const openModal = useAppStore((s) => s.openModal)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const allWorktrees = useAllWorktrees()
  const repos = useAppStore((s) => s.repos)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  // Why: getWorktreeStatus needs per-pane titles so split-pane tabs with a
  // working agent in a non-focused pane still surface as 'working' in the
  // jump palette. Without this, clicking between panes would desync the
  // palette's spinner from the sidebar's spinner.
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  // Why: ptyIdsByTabId is the live-pty source of truth — without it,
  // getWorktreeStatus would treat slept tabs as live (their preserved
  // tab.ptyId is a wake-hint sessionId, not a liveness signal) and the jump
  // palette dot would lie green even though the sidebar dot is correctly grey.
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const prCache = useAppStore((s) => s.prCache)
  const issueCache = useAppStore((s) => s.issueCache)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const activeBrowserTabId = useAppStore((s) => s.activeBrowserTabId)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const browserPagesByWorkspace = useAppStore((s) => s.browserPagesByWorkspace)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const lastVisitedAtByWorktreeId = useAppStore((s) => s.lastVisitedAtByWorktreeId)

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedItemId, setSelectedItemId] = useState('')
  const previousWorktreeIdRef = useRef<string | null>(null)
  const previousActiveTabTypeRef = useRef<'browser' | 'editor' | 'terminal' | 'notes'>('terminal')
  const previousBrowserPageIdRef = useRef<string | null>(null)
  const previousBrowserFocusTargetRef = useRef<'webview' | 'address-bar'>('webview')
  const wasVisibleRef = useRef(false)
  const skipRestoreFocusRef = useRef(false)
  const prevQueryRef = useRef('')
  const listRef = useRef<HTMLDivElement>(null)

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])
  const canCreateWorktree = useMemo(() => repos.some((repo) => isGitRepoKind(repo)), [repos])

  const hasQuery = deferredQuery.trim().length > 0

  // Why: keep the jump palette aligned with the sidebar. If the user
  // opted to hide the default-branch workspace, surfacing it here via
  // Cmd+J would reintroduce the entry they asked to remove.
  // Drift warning: this check must stay in lockstep with the sidebar's
  // filter in computeVisibleWorktreeIds (visible-worktrees.ts). Both
  // surfaces share isDefaultBranchWorkspace so the predicate can't drift,
  // but adding a new filter axis (e.g. a second toggle) here would need
  // the matching change in the sidebar pipeline — otherwise Cmd+J and
  // the sidebar will show different lists.
  const visibleWorktrees = useMemo(
    () =>
      allWorktrees.filter((worktree) => {
        if (worktree.isArchived) {
          return false
        }
        if (hideDefaultBranchWorkspace && isDefaultBranchWorkspace(worktree)) {
          return false
        }
        return true
      }),
    [allWorktrees, hideDefaultBranchWorkspace]
  )

  // Why: empty-query rows use focus-recency (lastVisitedAtByWorktreeId) with
  // lastActivityAt fallback so SSH / quiet worktrees don't get pushed below
  // the fold by noisy local worktrees. Current worktree is excluded from the
  // empty-query rows per product model (Cmd+J is a switch surface, not a
  // "show me everything" surface), but kept in visibleWorktreesForState so
  // empty-state/loading logic remains unaffected.
  // See docs/cmd-j-empty-query-ordering.md.
  const { visibleWorktreesForState, switchableWorktreesForRows } = useMemo(
    () =>
      orderEmptyQueryWorktrees({
        visibleWorktrees,
        activeWorktreeId,
        lastVisitedAtByWorktreeId
      }),
    [visibleWorktrees, activeWorktreeId, lastVisitedAtByWorktreeId]
  )

  // Why: typed queries still route through sortWorktreesSmart — switcher
  // ranking only diverges from smart-sort on the empty-query branch.
  const sortedWorktrees = useMemo(
    () =>
      hasQuery
        ? sortWorktreesSmart(
            visibleWorktrees,
            tabsByWorktree,
            repoMap,
            agentStatusByPaneKey,
            runtimePaneTitlesByTabId,
            ptyIdsByTabId
          )
        : switchableWorktreesForRows,
    [
      hasQuery,
      visibleWorktrees,
      switchableWorktreesForRows,
      tabsByWorktree,
      repoMap,
      agentStatusByPaneKey,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId
    ]
  )

  const browserSortedWorktrees = useMemo(() => {
    // Why: browser-tab search is explicitly cross-worktree, so it must keep
    // indexing live browser pages even when their owning worktree is archived
    // or hidden by the default-branch-workspace setting. A user who opened a
    // tab on the default-branch worktree before toggling hide-on should still
    // be able to Cmd+J back to it — the setting hides the *workspace row*,
    // not the browser tabs that live inside it.
    return sortWorktreesSmart(
      allWorktrees,
      tabsByWorktree,
      repoMap,
      agentStatusByPaneKey,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId
    )
  }, [
    allWorktrees,
    tabsByWorktree,
    repoMap,
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId
  ])

  // Why: browser rows need worktree lookups for repo badge colors, and browser
  // search intentionally includes archived worktrees. This map must cover all
  // worktrees, not just the non-archived sortedWorktrees used for the Worktrees scope.
  const worktreeMap = useMemo(() => {
    const map = new Map<string, Worktree>()
    for (const worktree of browserSortedWorktrees) {
      map.set(worktree.id, worktree)
    }
    return map
  }, [browserSortedWorktrees])

  const worktreeOrder = useMemo(
    () => new Map(browserSortedWorktrees.map((worktree, index) => [worktree.id, index])),
    [browserSortedWorktrees]
  )

  const worktreeMatches = useMemo(
    () => searchWorktrees(sortedWorktrees, deferredQuery.trim(), repoMap, prCache, issueCache),
    [sortedWorktrees, deferredQuery, repoMap, prCache, issueCache]
  )

  const browserPageEntries = useMemo<SearchableBrowserPage[]>(() => {
    const entries: SearchableBrowserPage[] = []
    for (const worktree of browserSortedWorktrees) {
      const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
      const worktreeSortIndex = worktreeOrder.get(worktree.id) ?? Number.MAX_SAFE_INTEGER
      const workspaces = browserTabsByWorktree[worktree.id] ?? []
      for (const workspace of workspaces) {
        const pages = browserPagesByWorkspace[workspace.id] ?? []
        for (const page of pages) {
          entries.push({
            page,
            workspace,
            worktree,
            repoName,
            worktreeSortIndex,
            isCurrentPage:
              workspace.id === activeBrowserTabId && workspace.activePageId === page.id,
            isCurrentWorktree: activeWorktreeId === worktree.id
          })
        }
      }
    }
    return entries
  }, [
    activeBrowserTabId,
    activeWorktreeId,
    browserPagesByWorkspace,
    browserTabsByWorktree,
    browserSortedWorktrees,
    repoMap,
    worktreeOrder
  ])

  const browserMatches = useMemo(
    () => searchBrowserPages(browserPageEntries, deferredQuery.trim()),
    [browserPageEntries, deferredQuery]
  )

  const worktreeItems = useMemo<WorktreePaletteItem[]>(
    () =>
      worktreeMatches
        .map((match) => {
          const worktree = worktreeMap.get(match.worktreeId)
          if (!worktree) {
            return null
          }
          return {
            id: `worktree:${worktree.id}`,
            type: 'worktree' as const,
            match,
            worktree
          }
        })
        .filter((item): item is WorktreePaletteItem => item !== null),
    [worktreeMap, worktreeMatches]
  )

  const browserItems = useMemo<BrowserPaletteItem[]>(
    () =>
      browserMatches.map((result) => ({
        id: `browser-page:${result.pageId}`,
        type: 'browser-page' as const,
        result
      })),
    [browserMatches]
  )

  // Why: on empty query we cap the worktree section (not browser tabs) so the
  // BROWSER TABS header + ≥1 page row stays visible above the fold — users
  // with 30+ worktrees would otherwise never see browser pages. The cap is
  // paired with a "Type to see all N worktrees" hint row so the full list is
  // one keystroke away. Typing lifts both caps. Cap size is tied to the
  // palette's max-h-[min(460px,62vh)] viewport math: ~60px/row, ~32px/header,
  // leaves room for BROWSER TABS header + one page row at default window size.
  // Revisit if row heights or max-h change.
  const EMPTY_QUERY_WORKTREE_CAP = 5
  const EMPTY_QUERY_BROWSER_CAP = 5

  const listEntries = useMemo<PaletteListEntry[]>(() => {
    const entries: PaletteListEntry[] = []

    // Why: the worktree cap only earns its keep when there are browser tabs
    // to protect above-the-fold. With zero browser pages, capping would force
    // the user to type for no reason — uncap so the recent list fills the
    // viewport naturally.
    const worktreeCap = !hasQuery && browserItems.length > 0 ? EMPTY_QUERY_WORKTREE_CAP : Infinity
    const visibleWorktreeItems = hasQuery ? worktreeItems : worktreeItems.slice(0, worktreeCap)
    const visibleBrowserItems = hasQuery
      ? browserItems
      : browserItems.slice(0, EMPTY_QUERY_BROWSER_CAP)

    // Header rule: on empty query each section is categorically distinct
    // (worktrees vs. tabs), so a lone header is a useful signpost. On query,
    // suppress headers unless both sections are populated — otherwise a lone
    // header above one list is noise.
    const showWorktreeHeader = hasQuery
      ? visibleWorktreeItems.length > 0 && visibleBrowserItems.length > 0
      : visibleWorktreeItems.length > 0
    const showBrowserHeader = hasQuery
      ? visibleWorktreeItems.length > 0 && visibleBrowserItems.length > 0
      : visibleBrowserItems.length > 0

    // Why: only surface the hint when there's actually something hidden,
    // otherwise the row would be a lie.
    const showWorktreeHint = !hasQuery && worktreeItems.length > worktreeCap

    if (visibleWorktreeItems.length > 0) {
      if (showWorktreeHeader) {
        entries.push({
          id: '__header_worktrees__',
          type: 'section-header',
          label: hasQuery ? 'Worktrees' : 'Recent Worktrees'
        })
      }
      entries.push(...visibleWorktreeItems)
      if (showWorktreeHint) {
        entries.push({
          id: '__hint_worktree_cap__',
          type: 'hint',
          label: `Type to see all ${worktreeItems.length} worktrees`
        })
      }
    }
    if (visibleBrowserItems.length > 0) {
      if (showBrowserHeader) {
        entries.push({
          id: '__header_browser__',
          type: 'section-header',
          label: 'Browser Tabs'
        })
      }
      entries.push(...visibleBrowserItems)
    }
    return entries
  }, [worktreeItems, browserItems, hasQuery])

  const selectableItems = useMemo<PaletteItem[]>(
    () =>
      listEntries.filter((e): e is PaletteItem => e.type !== 'section-header' && e.type !== 'hint'),
    [listEntries]
  )

  const createWorktreeName = deferredQuery.trim()
  const showCreateAction =
    canCreateWorktree && createWorktreeName.length > 0 && worktreeItems.length === 0

  const isLoading = repos.length > 0 && Object.keys(worktreesByRepo).length === 0
  // Why: empty-state / "has any worktrees?" uses the full visible list
  // (including current) so the palette never claims to be empty just
  // because the only visible worktree is the currently active one.
  // See docs/cmd-j-empty-query-ordering.md.
  const hasAnyWorktrees = visibleWorktreesForState.length > 0
  const hasAnyBrowserPages = browserPageEntries.length > 0

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      previousWorktreeIdRef.current = activeWorktreeId
      previousActiveTabTypeRef.current = activeTabType
      previousBrowserPageIdRef.current =
        activeWorktreeId && activeTabType === 'browser'
          ? ((browserTabsByWorktree[activeWorktreeId] ?? []).find(
              (workspace) => workspace.id === activeBrowserTabId
            )?.activePageId ?? null)
          : null
      // Why: capture which browser surface had focus *before* Radix Dialog
      // steals it. By onOpenAutoFocus time, document.activeElement has already
      // moved to the dialog content, so address-bar detection must happen here.
      previousBrowserFocusTargetRef.current =
        activeTabType === 'browser' &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('[data-orca-browser-address-bar="true"]')
          ? 'address-bar'
          : 'webview'
      skipRestoreFocusRef.current = false
      prevQueryRef.current = ''
      setQuery('')
      setSelectedItemId('')
    }

    wasVisibleRef.current = visible
  }, [activeBrowserTabId, activeTabType, activeWorktreeId, browserTabsByWorktree, visible])

  useEffect(() => {
    if (!visible) {
      return
    }
    const queryChanged = deferredQuery !== prevQueryRef.current
    prevQueryRef.current = deferredQuery

    const firstSelectableId = showCreateAction ? '__create_worktree__' : null

    if (queryChanged) {
      if (selectableItems.length > 0) {
        setSelectedItemId(selectableItems[0].id)
      } else {
        setSelectedItemId(firstSelectableId ?? '')
      }
      listRef.current?.scrollTo(0, 0)
      return
    }

    if (selectableItems.length === 0) {
      setSelectedItemId(firstSelectableId ?? '')
      return
    }

    if (selectedItemId === '__create_worktree__' && showCreateAction) {
      return
    }

    if (
      !selectableItems.some((item) => item.id === selectedItemId) &&
      selectedItemId !== firstSelectableId
    ) {
      setSelectedItemId(firstSelectableId ?? selectableItems[0].id)
    }
  }, [deferredQuery, selectedItemId, showCreateAction, visible, selectableItems])

  const focusFallbackSurface = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const xterm = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
        if (xterm) {
          xterm.focus()
          return
        }
        const monaco = document.querySelector('.monaco-editor textarea') as HTMLElement | null
        if (monaco) {
          monaco.focus()
        }
      })
    })
  }, [])

  const requestBrowserFocus = useCallback(
    (detail: { pageId: string; target: 'webview' | 'address-bar' }) => {
      queueBrowserFocusRequest(detail)
      window.dispatchEvent(
        new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, {
          detail
        })
      )
    },
    []
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }

      closeModal()
      if (skipRestoreFocusRef.current) {
        return
      }
      if (previousActiveTabTypeRef.current === 'browser' && previousBrowserPageIdRef.current) {
        // Why: dismissing Cmd+J from a browser surface should return focus to
        // that page, not fall through to the generic terminal/editor fallback.
        requestBrowserFocus({
          pageId: previousBrowserPageIdRef.current,
          target: previousBrowserFocusTargetRef.current
        })
        return
      }
      if (previousWorktreeIdRef.current) {
        focusFallbackSurface()
      }
    },
    [closeModal, focusFallbackSurface, requestBrowserFocus]
  )

  const handleSelectWorktree = useCallback(
    (worktreeId: string) => {
      const worktree = findWorktreeById(useAppStore.getState().worktreesByRepo, worktreeId)
      if (!worktree) {
        toast.error('Worktree no longer exists')
        return
      }
      activateAndRevealWorktree(worktreeId)
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      focusFallbackSurface()
    },
    [closeModal, focusFallbackSurface]
  )

  const handleSelectBrowserPage = useCallback(
    (result: BrowserPaletteSearchResult) => {
      const { pageId, workspaceId, worktreeId } = result
      const selection = findBrowserSelection(pageId, workspaceId, worktreeId)
      if (!selection) {
        toast.error('Browser page no longer exists')
        return
      }
      // Why: capture the workspace and page info before activateAndRevealWorktree
      // mutates store state. Store cascades during worktree activation can remap
      // browser workspace state, making a second findBrowserSelection unreliable.
      const { worktree, workspace, page } = selection
      const activated = activateAndRevealWorktree(worktree.id)
      if (!activated) {
        toast.error('Worktree no longer exists')
        return
      }

      const state = useAppStore.getState()
      state.setActiveBrowserTab(workspace.id)
      state.setActiveBrowserPage(workspace.id, pageId)
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      requestBrowserFocus({
        pageId,
        target: isBlankBrowserUrl(page.url) ? 'address-bar' : 'webview'
      })
    },
    [closeModal, requestBrowserFocus]
  )

  const handleSelectItem = useCallback(
    (item: PaletteItem) => {
      if (item.type === 'worktree') {
        handleSelectWorktree(item.worktree.id)
      } else {
        handleSelectBrowserPage(item.result)
      }
    },
    [handleSelectBrowserPage, handleSelectWorktree]
  )

  const handleCreateWorktree = useCallback(() => {
    skipRestoreFocusRef.current = true
    const trimmed = createWorktreeName.trim()
    const ghLink = parseGitHubIssueOrPRLink(trimmed)
    const ghNumber = parseGitHubIssueOrPRNumber(trimmed)

    const openComposer = (data: Record<string, unknown>): void => {
      closeModal()
      // Why: defer opening so Radix fully unmounts the palette's dialog before
      // the composer modal mounts, avoiding focus churn between the two.
      queueMicrotask(() =>
        openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
      )
    }

    // Case 1: user pasted a GH issue/PR URL.
    if (ghLink) {
      const { slug, number } = ghLink
      const state = useAppStore.getState()

      // Why: the existing-worktree check only needs the issue/PR number, which
      // is repo-agnostic on the worktree meta side. We don't currently cache a
      // repo-slug map, so slug-matching against a specific repo happens
      // implicitly when we pick a repo for the `gh workItem` lookup below.
      const matches = allWorktrees.filter(
        (w) => !w.isArchived && (w.linkedIssue === number || w.linkedPR === number)
      )
      const activeMatch = matches.find((w) => w.repoId === state.activeRepoId) ?? matches[0]
      if (activeMatch) {
        closeModal()
        activateAndRevealWorktree(activeMatch.id)
        return
      }

      // Resolve via gh.workItem: prefer the active repo, else the first eligible.
      const eligibleRepos = state.repos.filter((r) => isGitRepoKind(r))
      const repoForLookup =
        (state.activeRepoId && eligibleRepos.find((r) => r.id === state.activeRepoId)) ||
        eligibleRepos[0]
      if (!repoForLookup) {
        openComposer({ prefilledName: trimmed })
        return
      }

      // Why: awaiting inside the user gesture would leave the palette open
      // indefinitely on slow networks. Close immediately and populate the
      // composer once the lookup returns.
      closeModal()
      void window.api.gh
        .workItem({ repoPath: repoForLookup.path, number })
        .then((item) => {
          const data: Record<string, unknown> = { initialRepoId: repoForLookup.id }
          if (item) {
            const linkedWorkItem: LinkedWorkItemSummary = {
              type: item.type,
              number: item.number,
              title: item.title,
              url: item.url
            }
            data.linkedWorkItem = linkedWorkItem
            data.prefilledName = getLinkedWorkItemSuggestedName({ title: item.title })
          } else {
            // Fallback: we couldn't resolve the URL, just seed the name.
            data.prefilledName = `${slug.owner}-${slug.repo}-${number}`
          }
          queueMicrotask(() =>
            openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
          )
        })
        .catch(() => {
          queueMicrotask(() =>
            openModal('new-workspace-composer', {
              initialRepoId: repoForLookup.id,
              telemetrySource: 'command_palette'
            })
          )
        })
      return
    }

    // Case 2: user typed a raw issue number. Resolve against the active repo.
    if (ghNumber !== null) {
      const state = useAppStore.getState()
      const matches = allWorktrees.filter(
        (w) => !w.isArchived && (w.linkedIssue === ghNumber || w.linkedPR === ghNumber)
      )
      const activeMatch = matches.find((w) => w.repoId === state.activeRepoId) ?? matches[0]
      if (activeMatch) {
        closeModal()
        activateAndRevealWorktree(activeMatch.id)
        return
      }

      const repoForLookup =
        (state.activeRepoId ? (repoMap.get(state.activeRepoId) ?? null) : null) ||
        [...getRepoMapFromState(state).values()].find((repo) => isGitRepoKind(repo))
      if (!repoForLookup || !isGitRepoKind(repoForLookup)) {
        openComposer({ prefilledName: trimmed })
        return
      }

      closeModal()
      void window.api.gh
        .workItem({ repoPath: repoForLookup.path, number: ghNumber })
        .then((item) => {
          const data: Record<string, unknown> = { initialRepoId: repoForLookup.id }
          if (item) {
            const linkedWorkItem: LinkedWorkItemSummary = {
              type: item.type,
              number: item.number,
              title: item.title,
              url: item.url
            }
            data.linkedWorkItem = linkedWorkItem
            data.prefilledName = getLinkedWorkItemSuggestedName({ title: item.title })
          } else {
            data.prefilledName = trimmed
          }
          queueMicrotask(() =>
            openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
          )
        })
        .catch(() => {
          queueMicrotask(() =>
            openModal('new-workspace-composer', {
              initialRepoId: repoForLookup.id,
              prefilledName: trimmed,
              telemetrySource: 'command_palette'
            })
          )
        })
      return
    }

    // Case 3: plain name — open composer prefilled.
    openComposer(trimmed ? { prefilledName: trimmed } : {})
  }, [allWorktrees, closeModal, createWorktreeName, openModal, repoMap])

  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
  }, [])

  const handleOpenAutoFocus = useCallback((_event: Event) => {
    // No-op: address-bar detection is handled in the visible effect before
    // Radix steals focus. This callback exists only to satisfy the prop API.
  }, [])

  const resultCount = selectableItems.length
  const emptyState = (() => {
    if ((hasAnyWorktrees || hasAnyBrowserPages) && hasQuery) {
      return {
        title: 'No results match your search',
        subtitle: 'Try a name, branch, repo, comment, PR, page title, or URL.'
      }
    }
    // Why: empty-query rows exclude the current worktree, so a single-worktree
    // setup has hasAnyWorktrees=true but zero switchable rows. Without this
    // branch the palette would claim "No active worktrees" while one is open
    // — misleading. See docs/cmd-j-empty-query-ordering.md.
    if (!hasQuery && hasAnyWorktrees && !hasAnyBrowserPages) {
      return {
        title: 'No other worktrees to switch to',
        subtitle: 'Type to search or create a new worktree.'
      }
    }
    return {
      title: 'No active worktrees or browser tabs',
      subtitle: 'Create a worktree or open a page in Orca to get started.'
    }
  })()

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      title="Jump to..."
      description="Search worktrees and browser tabs"
      overlayClassName="bg-black/55 backdrop-blur-[2px]"
      contentClassName="top-[13%] w-[736px] max-w-[94vw] overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-[0_26px_84px_rgba(0,0,0,0.32)] backdrop-blur-xl"
      commandProps={{
        loop: true,
        value: selectedItemId,
        onValueChange: setSelectedItemId,
        className: 'bg-transparent'
      }}
    >
      <CommandInput
        placeholder={'Jump to worktree or browser tab\u2026  try "repo/worktree"'}
        value={query}
        onValueChange={setQuery}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 text-[14px] placeholder:text-muted-foreground/75"
      />
      <CommandList ref={listRef} className="max-h-[min(460px,62vh)] px-2.5 pb-2.5 pt-2">
        {isLoading ? (
          <PaletteState
            title="Loading jump targets"
            subtitle="Gathering your recent worktrees and open browser pages."
          />
        ) : selectableItems.length === 0 && !showCreateAction ? (
          <CommandEmpty className="py-0">
            <PaletteState title={emptyState.title} subtitle={emptyState.subtitle} />
          </CommandEmpty>
        ) : (
          <>
            {listEntries.map((entry) => {
              if (entry.type === 'section-header') {
                return (
                  <div
                    key={entry.id}
                    className="mx-0.5 mt-3 mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
                  >
                    {entry.label}
                  </div>
                )
              }

              if (entry.type === 'hint') {
                // Why: plain div (not CommandItem) so cmdk can't land selection
                // on it and arrow keys skip over it naturally via selectableItems.
                return (
                  <div
                    key={entry.id}
                    className="mx-0.5 mt-1 px-3 py-1.5 text-[12px] italic text-muted-foreground/70"
                  >
                    {entry.label}
                  </div>
                )
              }

              if (entry.type === 'worktree') {
                const worktree = entry.worktree
                const repo = repoMap.get(worktree.repoId)
                const repoName = repo?.displayName ?? ''
                const branch = branchName(worktree.branch)
                const status = getWorktreeStatus(
                  tabsByWorktree[worktree.id] ?? [],
                  browserTabsByWorktree[worktree.id] ?? [],
                  ptyIdsByTabId,
                  runtimePaneTitlesByTabId
                )
                const statusLabel = getWorktreeStatusLabel(status)
                const isCurrentWorktree = activeWorktreeId === worktree.id
                const sshConnectionId = repo?.connectionId ?? null
                const sshStatus = sshConnectionId
                  ? (sshConnectionStates.get(sshConnectionId)?.status ?? 'disconnected')
                  : null
                const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'

                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelectItem(entry)}
                    data-current={isCurrentWorktree ? 'true' : undefined}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5">
                      <StatusIndicator status={status} aria-hidden="true" />
                      <span className="sr-only">{statusLabel}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            {sshConnectionId && (
                              <span
                                aria-label={isSshDisconnected ? 'SSH disconnected' : 'SSH remote'}
                                className="shrink-0 inline-flex items-center"
                              >
                                {isSshDisconnected ? (
                                  <ServerOff className="size-3.5 text-red-400" aria-hidden="true" />
                                ) : (
                                  <Server
                                    className="size-3.5 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                )}
                              </span>
                            )}
                            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                              {entry.match.displayNameRange ? (
                                <HighlightedText
                                  text={worktree.displayName}
                                  matchRange={entry.match.displayNameRange}
                                />
                              ) : (
                                worktree.displayName
                              )}
                            </span>
                            {isCurrentWorktree && (
                              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                                Current
                              </span>
                            )}
                            {worktree.isMainWorktree && (
                              <span className="shrink-0 self-center rounded border border-muted-foreground/30 bg-muted-foreground/5 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground">
                                primary
                              </span>
                            )}
                            <span className="shrink-0 text-muted-foreground/45">·</span>
                            <span className="truncate text-[12px] font-medium text-muted-foreground/92">
                              {entry.match.branchRange ? (
                                <HighlightedText
                                  text={branch}
                                  matchRange={entry.match.branchRange}
                                />
                              ) : (
                                branch
                              )}
                            </span>
                          </div>
                          {entry.match.supportingText && (
                            <div className="mt-1.5 flex min-w-0 items-start gap-2 text-[12px] leading-5 text-muted-foreground/88">
                              <span className="shrink-0 rounded-full border border-border/45 bg-background/45 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
                                {entry.match.supportingText.label}
                              </span>
                              <span className="truncate">
                                <HighlightedText
                                  text={entry.match.supportingText.text}
                                  matchRange={entry.match.supportingText.matchRange}
                                />
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {repoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <span
                                aria-hidden="true"
                                className="size-1.5 shrink-0 rounded-full"
                                style={
                                  repo?.badgeColor
                                    ? { backgroundColor: repo.badgeColor }
                                    : undefined
                                }
                              />
                              <span className="truncate">
                                {entry.match.repoRange ? (
                                  <HighlightedText
                                    text={repoName}
                                    matchRange={entry.match.repoRange}
                                  />
                                ) : (
                                  repoName
                                )}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              const result = entry.result
              const browserWorktree = worktreeMap.get(result.worktreeId)
              const browserRepo = browserWorktree ? repoMap.get(browserWorktree.repoId) : undefined
              const browserRepoName = browserRepo?.displayName ?? result.repoName

              return (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  onSelect={() => handleSelectItem(entry)}
                  className={cn(
                    'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                    'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                  )}
                >
                  <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5 text-muted-foreground/85">
                    <Globe className="size-3.5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="max-w-[40%] shrink-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                            <HighlightedText text={result.title} matchRange={result.titleRange} />
                          </span>
                          {result.isCurrentPage && (
                            <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                              Current Tab
                            </span>
                          )}
                          {!result.isCurrentPage && result.isCurrentWorktree && (
                            <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                              Current Worktree
                            </span>
                          )}
                          <span className="shrink-0 text-muted-foreground/45">·</span>
                          <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/92">
                            <HighlightedText
                              text={result.secondaryText}
                              matchRange={result.secondaryRange}
                            />
                          </span>
                          <span className="shrink-0 text-muted-foreground/45">·</span>
                          <span className="shrink-0 text-[12px] font-medium text-muted-foreground/92">
                            <HighlightedText
                              text={result.worktreeName}
                              matchRange={result.worktreeRange}
                            />
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {browserRepoName && (
                          <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                            <span
                              aria-hidden="true"
                              className="size-1.5 shrink-0 rounded-full"
                              style={
                                browserRepo?.badgeColor
                                  ? { backgroundColor: browserRepo.badgeColor }
                                  : undefined
                              }
                            />
                            <span className="truncate">
                              <HighlightedText
                                text={browserRepoName}
                                matchRange={result.repoRange}
                              />
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </CommandItem>
              )
            })}
            {showCreateAction && (
              // Why: render the create action last so cmdk does not briefly
              // auto-select it before our effect promotes the first real match
              // when the query only matches browser pages.
              <CommandItem
                value="__create_worktree__"
                onSelect={handleCreateWorktree}
                className="group mx-0.5 mt-1 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 text-left outline-none transition-[background-color,border-color,box-shadow] data-[selected=true]:border-border data-[selected=true]:bg-neutral-100 data-[selected=true]:text-foreground dark:data-[selected=true]:bg-neutral-800"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/25 text-muted-foreground/70">
                  <Plus size={13} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                    {`Create worktree "${createWorktreeName}"`}
                  </div>
                </div>
              </CommandItem>
            )}
          </>
        )}
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>Enter</FooterKey>
          <span>Open</span>
          <FooterKey>Esc</FooterKey>
          <span>Close</span>
          <FooterKey>↑↓</FooterKey>
          <span>Move</span>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {deferredQuery.trim()
          ? `${resultCount} results found${showCreateAction ? ', create new worktree action available' : ''}`
          : `${resultCount} items available${showCreateAction ? ', create new worktree action available' : ''}`}
      </div>
    </CommandDialog>
  )
}
