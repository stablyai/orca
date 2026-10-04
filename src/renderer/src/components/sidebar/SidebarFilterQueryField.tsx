import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import { useSidebarHostOptions } from './worktree-list/listing/use-sidebar-host-options'
import {
  applySidebarFilterSuggestion,
  getSidebarFilterQuerySuggestions,
  type SidebarFilterSuggestionCatalog,
  type SidebarFilterSuggestionSet
} from './sidebar-filter-query-suggestions'
import type { WorkspaceFilterQualifierKey } from './workspace-filter-query'

function qualifierDetail(key: WorkspaceFilterQualifierKey): string {
  switch (key) {
    case 'name':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.0f8d520dd0',
        'workspace name'
      )
    case 'repo':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.132df25183',
        'project name or path'
      )
    case 'branch':
      return translate('auto.components.sidebar.SidebarFilterQueryField.46399c418f', 'branch name')
    case 'host':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.9787a72366',
        'execution host'
      )
    case 'path':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.eae0f4ca99',
        'checkout path'
      )
    case 'status':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.e8450c86f8',
        'workspace status'
      )
    case 'is':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.0d8ad67fa9',
        'pinned, main, sleeping, active, detached, cli, automation, unread, folder'
      )
    case 'pr':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.3734cb9183',
        'linked pull or merge request number'
      )
    case 'issue':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.b7db4543a5',
        'linked issue number'
      )
    case 'any':
      return translate(
        'auto.components.sidebar.SidebarFilterQueryField.2584a36229',
        'match any field, including comments, reviews and ports'
      )
  }
}
import { SidebarSavedFilterViewsMenu } from './SidebarSavedFilterViewsMenu'

const EMPTY_REPOS: readonly Repo[] = []
const EMPTY_STATUSES: readonly WorkspaceStatusDefinition[] = []
const EMPTY_WORKTREES: readonly Worktree[] = []

/**
 * The typed filter for the workspace list: GitHub-style grammar with
 * qualifier autocomplete, a live match counter, and saved views.
 */
const SidebarFilterQueryField = React.memo(function SidebarFilterQueryField() {
  const query = useAppStore((s) => s.sidebarFilterQuery ?? '')
  const setQuery = useAppStore((s) => s.setSidebarFilterQuery)
  const matchCount = useAppStore((s) => s.sidebarFilterMatchCount)
  // Why the fallbacks: lightweight test stores mock only the slices they exercise.
  const repos = useAppStore((s) => s.repos ?? EMPTY_REPOS)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses ?? EMPTY_STATUSES)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const hostOptions = useSidebarHostOptions()
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const [caret, setCaret] = useState(0)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)

  const liveWorktrees = useMemo(
    () =>
      worktreesByRepo
        ? getAllWorktreesFromState({ worktreesByRepo }).filter((worktree) => !worktree.isArchived)
        : EMPTY_WORKTREES,
    [worktreesByRepo]
  )
  const catalog = useMemo<SidebarFilterSuggestionCatalog>(
    () => ({
      hosts: hostOptions.map((host) => ({ id: host.id, label: host.label })),
      repos: repos.map((repo) => repo.displayName),
      branches: liveWorktrees.map((worktree) => resolveWorktreeBranchLabel(worktree)),
      statuses: workspaceStatuses.map((status) => ({
        id: status.id,
        label: status.label
      }))
    }),
    [hostOptions, liveWorktrees, repos, workspaceStatuses]
  )
  const suggestions = useMemo<SidebarFilterSuggestionSet | null>(
    () => (suggestionsOpen ? getSidebarFilterQuerySuggestions({ query, caret, catalog }) : null),
    [catalog, caret, query, suggestionsOpen]
  )
  const visibleItems = suggestions?.items ?? []
  const clampedActiveIndex = Math.min(activeIndex, Math.max(0, visibleItems.length - 1))

  // Why: the caret is restored after React commits the replaced text; setting
  // it in the same tick lands on the pre-update value.
  useEffect(() => {
    if (pendingCaret === null) {
      return
    }
    inputRef.current?.setSelectionRange(pendingCaret, pendingCaret)
    setPendingCaret(null)
  }, [pendingCaret, query])

  const syncCaret = useCallback(() => {
    setCaret(inputRef.current?.selectionStart ?? 0)
  }, [])

  const acceptSuggestion = useCallback(
    (index: number) => {
      const item = suggestions?.items[index]
      if (!suggestions || !item) {
        return
      }
      const applied = applySidebarFilterSuggestion(query, suggestions, item)
      setQuery(applied.query)
      setCaret(applied.caret)
      setPendingCaret(applied.caret)
      setActiveIndex(0)
      // Why: a completed qualifier key immediately wants its values.
      setSuggestionsOpen(item.replacement.endsWith(':'))
    },
    [query, setQuery, suggestions]
  )

  const clear = useCallback(() => {
    setQuery('')
    setCaret(0)
    setActiveIndex(0)
    inputRef.current?.focus()
  }, [setQuery])

  const hasText = query !== ''
  const counterText = matchCount !== null ? `${matchCount} / ${liveWorktrees.length}` : null
  const listOpen = suggestionsOpen && visibleItems.length > 0

  return (
    <div className="relative flex shrink-0 items-center gap-1 px-2 pb-1">
      <div className="relative flex min-w-0 flex-1 items-center">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={listOpen ? `${listboxId}-${clampedActiveIndex}` : undefined}
          aria-label={translate(
            'auto.components.sidebar.SidebarFilterQueryField.c78a56fadc',
            'Filter workspaces'
          )}
          placeholder={translate(
            'auto.components.sidebar.SidebarFilterQueryField.0c048febe3',
            'Filter — try host: branch: is:'
          )}
          type="text"
          spellCheck={false}
          autoComplete="off"
          // Why a plain input: the shadcn field is sized for forms; this is
          // 28px sidebar chrome, and restyling the primitive is off-limits.
          className={cn(
            'h-7 w-full min-w-0 rounded-md border border-border bg-background pl-6 text-[11px] text-foreground outline-none',
            'placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            hasText ? 'pr-16' : 'pr-2'
          )}
          onChange={(event) => {
            setQuery(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
            setActiveIndex(0)
            setSuggestionsOpen(true)
          }}
          onFocus={() => {
            syncCaret()
            setSuggestionsOpen(true)
          }}
          onBlur={() => setSuggestionsOpen(false)}
          onClick={syncCaret}
          onKeyUp={(event) => {
            if (
              event.key === 'ArrowLeft' ||
              event.key === 'ArrowRight' ||
              event.key === 'Home' ||
              event.key === 'End'
            ) {
              syncCaret()
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return
            }
            if (listOpen && event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((clampedActiveIndex + 1) % visibleItems.length)
              return
            }
            if (listOpen && event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((clampedActiveIndex - 1 + visibleItems.length) % visibleItems.length)
              return
            }
            if (listOpen && (event.key === 'Tab' || event.key === 'Enter')) {
              event.preventDefault()
              acceptSuggestion(clampedActiveIndex)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              if (listOpen) {
                setSuggestionsOpen(false)
                return
              }
              if (hasText) {
                clear()
                return
              }
              inputRef.current?.blur()
            }
          }}
        />
        {hasText ? (
          <div className="absolute right-1 flex items-center gap-0.5">
            {counterText ? (
              <span aria-hidden="true" className="text-[10px] tabular-nums text-muted-foreground">
                {counterText}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.sidebar.SidebarFilterQueryField.0533a99376',
                'Clear filter'
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={clear}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : null}
        {listOpen ? (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md scrollbar-sleek"
          >
            {visibleItems.map((item, index) => (
              <li
                key={item.replacement}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === clampedActiveIndex}
                className={cn(
                  'flex cursor-default items-baseline gap-2 rounded-sm px-2 py-1 text-[11px]',
                  index === clampedActiveIndex && 'bg-accent text-accent-foreground'
                )}
                // Why: mousedown would blur the input and close the list before click fires.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => acceptSuggestion(index)}
              >
                <span className="font-mono">{item.label}</span>
                {item.qualifier || item.detail ? (
                  <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                    {item.qualifier ? qualifierDetail(item.qualifier) : item.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <SidebarSavedFilterViewsMenu query={query} onApply={setQuery} />
      <div role="status" aria-live="polite" className="sr-only">
        {counterText
          ? translate(
              'auto.components.sidebar.SidebarFilterQueryField.2d75a40c73',
              '{{value0}} of {{value1}} workspaces match',
              {
                value0: matchCount ?? 0,
                value1: liveWorktrees.length
              }
            )
          : ''}
      </div>
    </div>
  )
})

export default SidebarFilterQueryField
