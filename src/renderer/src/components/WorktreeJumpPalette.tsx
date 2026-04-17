/* oxlint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Globe, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
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

type PaletteScope = 'worktrees' | 'browser-tabs'

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

type PaletteItem = WorktreePaletteItem | BrowserPaletteItem

type BrowserSelection = {
  worktree: Worktree
  workspace: BrowserWorkspace
  page: BrowserPage
}

const SCOPE_ORDER: PaletteScope[] = ['worktrees', 'browser-tabs']

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

function nextScope(scope: PaletteScope, direction: 1 | -1): PaletteScope {
  const index = SCOPE_ORDER.indexOf(scope)
  const nextIndex = (index + direction + SCOPE_ORDER.length) % SCOPE_ORDER.length
  return SCOPE_ORDER[nextIndex]
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
  const repos = useAppStore((s) => s.repos)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const prCache = useAppStore((s) => s.prCache)
  const issueCache = useAppStore((s) => s.issueCache)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const activeBrowserTabId = useAppStore((s) => s.activeBrowserTabId)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const browserPagesByWorkspace = useAppStore((s) => s.browserPagesByWorkspace)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [scope, setScope] = useState<PaletteScope>('worktrees')
  const [selectedItemId, setSelectedItemId] = useState('')
  const previousWorktreeIdRef = useRef<string | null>(null)
  const previousActiveTabTypeRef = useRef<'browser' | 'editor' | 'terminal'>('terminal')
  const previousBrowserPageIdRef = useRef<string | null>(null)
  const previousBrowserFocusTargetRef = useRef<'webview' | 'address-bar'>('webview')
  const wasVisibleRef = useRef(false)
  const skipRestoreFocusRef = useRef(false)
  const prevQueryRef = useRef('')
  const prevScopeRef = useRef<PaletteScope>('worktrees')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 150)
    return () => clearTimeout(id)
  }, [query])

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])
  const canCreateWorktree = useMemo(() => repos.some((repo) => isGitRepoKind(repo)), [repos])

  const sortedWorktrees = useMemo(() => {
    const all: Worktree[] = Object.values(worktreesByRepo)
      .flat()
      .filter((w) => !w.isArchived)
    return sortWorktreesSmart(all, tabsByWorktree, repoMap, prCache)
  }, [worktreesByRepo, tabsByWorktree, repoMap, prCache])

  const browserSortedWorktrees = useMemo(() => {
    const all: Worktree[] = Object.values(worktreesByRepo).flat()
    // Why: browser-tab search is explicitly cross-worktree, so it must keep
    // indexing live browser pages even when their owning worktree is archived.
    return sortWorktreesSmart(all, tabsByWorktree, repoMap, prCache)
  }, [worktreesByRepo, tabsByWorktree, repoMap, prCache])

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
    () => searchWorktrees(sortedWorktrees, debouncedQuery.trim(), repoMap, prCache, issueCache),
    [sortedWorktrees, debouncedQuery, repoMap, prCache, issueCache]
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
    () => searchBrowserPages(browserPageEntries, debouncedQuery.trim()),
    [browserPageEntries, debouncedQuery]
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

  const visibleItems = useMemo<PaletteItem[]>(() => {
    if (scope === 'browser-tabs') {
      return browserItems
    }
    return worktreeItems
  }, [browserItems, scope, worktreeItems])

  const createWorktreeName = debouncedQuery.trim()
  const showCreateAction =
    scope === 'worktrees' &&
    canCreateWorktree &&
    createWorktreeName.length > 0 &&
    worktreeItems.length === 0

  const isLoading = repos.length > 0 && Object.keys(worktreesByRepo).length === 0
  const hasAnyWorktrees = sortedWorktrees.length > 0
  const hasAnyBrowserPages = browserPageEntries.length > 0
  const hasQuery = debouncedQuery.trim().length > 0

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      // Why: the palette now supports multiple scopes, but Cmd+J still has a
      // worktree-first contract. Reset to that scope on every open so browser
      // exploration remains opt-in rather than sticky across sessions.
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
      prevScopeRef.current = 'worktrees'
      setScope('worktrees')
      setQuery('')
      setDebouncedQuery('')
      setSelectedItemId('')
    }

    wasVisibleRef.current = visible
  }, [activeBrowserTabId, activeTabType, activeWorktreeId, browserTabsByWorktree, visible])

  useEffect(() => {
    if (!visible) {
      return
    }
    const queryChanged = debouncedQuery !== prevQueryRef.current
    const scopeChanged = scope !== prevScopeRef.current
    prevQueryRef.current = debouncedQuery
    prevScopeRef.current = scope

    const firstSelectableId = showCreateAction ? '__create_worktree__' : null

    if (queryChanged || scopeChanged) {
      if (visibleItems.length > 0) {
        setSelectedItemId(visibleItems[0].id)
      } else {
        setSelectedItemId(firstSelectableId ?? '')
      }
      listRef.current?.scrollTo(0, 0)
      return
    }

    if (visibleItems.length === 0) {
      setSelectedItemId(firstSelectableId ?? '')
      return
    }

    if (selectedItemId === '__create_worktree__' && showCreateAction) {
      return
    }

    if (
      !visibleItems.some((item) => item.id === selectedItemId) &&
      selectedItemId !== firstSelectableId
    ) {
      setSelectedItemId(firstSelectableId ?? visibleItems[0].id)
    }
  }, [debouncedQuery, scope, selectedItemId, showCreateAction, visible, visibleItems])

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
      queueMicrotask(() => openModal('new-workspace-composer', data))
    }

    // Case 1: user pasted a GH issue/PR URL.
    if (ghLink) {
      const { slug, number } = ghLink
      const state = useAppStore.getState()

      // Why: the existing-worktree check only needs the issue/PR number, which
      // is repo-agnostic on the worktree meta side. We don't currently cache a
      // repo-slug map, so slug-matching against a specific repo happens
      // implicitly when we pick a repo for the `gh workItem` lookup below.
      const allWorktrees = Object.values(state.worktreesByRepo).flat()
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
            data.prefilledName = getLinkedWorkItemSuggestedName(item)
          } else {
            // Fallback: we couldn't resolve the URL, just seed the name.
            data.prefilledName = `${slug.owner}-${slug.repo}-${number}`
          }
          queueMicrotask(() => openModal('new-workspace-composer', data))
        })
        .catch(() => {
          queueMicrotask(() =>
            openModal('new-workspace-composer', { initialRepoId: repoForLookup.id })
          )
        })
      return
    }

    // Case 2: user typed a raw issue number. Resolve against the active repo.
    if (ghNumber !== null) {
      const state = useAppStore.getState()
      const allWorktrees = Object.values(state.worktreesByRepo).flat()
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
        (state.activeRepoId && state.repos.find((r) => r.id === state.activeRepoId)) ||
        state.repos.find((r) => isGitRepoKind(r))
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
            data.prefilledName = getLinkedWorkItemSuggestedName(item)
          } else {
            data.prefilledName = trimmed
          }
          queueMicrotask(() => openModal('new-workspace-composer', data))
        })
        .catch(() => {
          queueMicrotask(() =>
            openModal('new-workspace-composer', {
              initialRepoId: repoForLookup.id,
              prefilledName: trimmed
            })
          )
        })
      return
    }

    // Case 3: plain name — open composer prefilled.
    openComposer(trimmed ? { prefilledName: trimmed } : {})
  }, [closeModal, createWorktreeName, openModal])

  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
  }, [])

  const handleOpenAutoFocus = useCallback((_event: Event) => {
    // No-op: address-bar detection is handled in the visible effect before
    // Radix steals focus. This callback exists only to satisfy the prop API.
  }, [])

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Tab') {
      return
    }
    // Why: the scope chips are part of the palette's search model, not the
    // browser's focus ring. Cycling them with Tab keeps the input focused and
    // avoids turning scope changes into a pointer-only affordance.
    event.preventDefault()
    setScope((current) => nextScope(current, event.shiftKey ? -1 : 1))
  }, [])

  const title = scope === 'browser-tabs' ? 'Open Browser Tab' : 'Open Worktree'
  const description =
    scope === 'browser-tabs'
      ? 'Search open browser pages across all worktrees'
      : 'Search across all worktrees by name, branch, comment, PR, or issue'
  const placeholder =
    scope === 'browser-tabs' ? 'Search open browser tabs...' : 'Jump to worktree...'

  const resultCount = visibleItems.length
  const emptyState = (() => {
    if (scope === 'browser-tabs') {
      return hasAnyBrowserPages && hasQuery
        ? {
            title: 'No browser tabs match your search',
            subtitle: 'Try a page title, URL, worktree name, or repo name.'
          }
        : {
            title: 'No open browser tabs',
            subtitle: 'Open a page in Orca and it will show up here.'
          }
    }
    return hasAnyWorktrees && hasQuery
      ? {
          title: 'No worktrees match your search',
          subtitle: 'Try a name, branch, repo, comment, PR, or issue.'
        }
      : {
          title: 'No active worktrees',
          subtitle: 'Create one to get started, then jump back here any time.'
        }
  })()

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      title={title}
      description={description}
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
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
        onKeyDown={handleInputKeyDown}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 text-[14px] placeholder:text-muted-foreground/75"
      />
      <div role="tablist" className="mx-3 mt-2 flex items-center gap-1.5 px-0.5">
        {SCOPE_ORDER.map((candidate) => {
          const active = candidate === scope
          const label = candidate === 'worktrees' ? 'Worktrees' : 'Browser Tabs'
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setScope(candidate)}
              className={cn(
                'inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
                active
                  ? 'border-border bg-accent/80 text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
      <CommandList ref={listRef} className="max-h-[min(460px,62vh)] px-2.5 pb-2.5 pt-2">
        {isLoading ? (
          <PaletteState
            title="Loading jump targets"
            subtitle="Gathering your recent worktrees and open browser pages."
          />
        ) : visibleItems.length === 0 && !showCreateAction ? (
          <CommandEmpty className="py-0">
            <PaletteState title={emptyState.title} subtitle={emptyState.subtitle} />
          </CommandEmpty>
        ) : (
          <>
            {showCreateAction && (
              <CommandItem
                value="__create_worktree__"
                onSelect={handleCreateWorktree}
                className="group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 text-left outline-none transition-[background-color,border-color,box-shadow] data-[selected=true]:border-border data-[selected=true]:bg-neutral-100 data-[selected=true]:text-foreground dark:data-[selected=true]:bg-neutral-800"
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
            {visibleItems.map((item) => {
              if (item.type === 'worktree') {
                const worktree = item.worktree
                const repo = repoMap.get(worktree.repoId)
                const repoName = repo?.displayName ?? ''
                const branch = branchName(worktree.branch)
                const status = getWorktreeStatus(
                  tabsByWorktree[worktree.id] ?? [],
                  browserTabsByWorktree[worktree.id] ?? []
                )
                const statusLabel = getWorktreeStatusLabel(status)
                const isCurrentWorktree = activeWorktreeId === worktree.id

                return (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => handleSelectItem(item)}
                    data-current={isCurrentWorktree ? 'true' : undefined}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-neutral-100 data-[selected=true]:text-foreground dark:data-[selected=true]:bg-neutral-800'
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
                            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                              {item.match.displayNameRange ? (
                                <HighlightedText
                                  text={worktree.displayName}
                                  matchRange={item.match.displayNameRange}
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
                              {item.match.branchRange ? (
                                <HighlightedText
                                  text={branch}
                                  matchRange={item.match.branchRange}
                                />
                              ) : (
                                branch
                              )}
                            </span>
                          </div>
                          {item.match.supportingText && (
                            <div className="mt-1.5 flex min-w-0 items-start gap-2 text-[12px] leading-5 text-muted-foreground/88">
                              <span className="shrink-0 rounded-full border border-border/45 bg-background/45 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
                                {item.match.supportingText.label}
                              </span>
                              <span className="truncate">
                                <HighlightedText
                                  text={item.match.supportingText.text}
                                  matchRange={item.match.supportingText.matchRange}
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
                                {item.match.repoRange ? (
                                  <HighlightedText
                                    text={repoName}
                                    matchRange={item.match.repoRange}
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

              const result = item.result
              const browserWorktree = worktreeMap.get(result.worktreeId)
              const browserRepo = browserWorktree ? repoMap.get(browserWorktree.repoId) : undefined
              const browserRepoName = browserRepo?.displayName ?? result.repoName

              return (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => handleSelectItem(item)}
                  className={cn(
                    'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                    'data-[selected=true]:border-border data-[selected=true]:bg-neutral-100 data-[selected=true]:text-foreground dark:data-[selected=true]:bg-neutral-800'
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
          </>
        )}
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>Enter</FooterKey>
          <span>Open</span>
          <FooterKey>Tab</FooterKey>
          <span>Switch</span>
          <FooterKey>Esc</FooterKey>
          <span>Close</span>
          <FooterKey>↑↓</FooterKey>
          <span>Move</span>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {debouncedQuery.trim()
          ? `${resultCount} results found in ${scope === 'worktrees' ? 'worktrees' : 'browser tabs'}${showCreateAction ? ', create new worktree action available' : ''}`
          : `${resultCount} ${scope === 'worktrees' ? 'worktrees' : 'browser tabs'} available${showCreateAction ? ', create new worktree action available' : ''}`}
      </div>
    </CommandDialog>
  )
}
