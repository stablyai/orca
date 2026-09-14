import React, { useId, useRef, useState } from 'react'
import { FolderMinus, Search } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import {
  getHiddenImportableExternalWorktrees,
  getVisibleNonOrcaWorktrees
} from '../../../../shared/external-worktree-inbox'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'

type Props = {
  repo: Repo
  detected: DetectedWorktreeListResult | undefined
  listState: 'checking' | 'ready' | 'failed'
  busyPath: string | null
  toggling: boolean
  onShow: (worktreePath: string) => Promise<void>
}

export default function HiddenWorktreeRecoveryList({
  repo,
  detected,
  listState,
  busyPath,
  toggling,
  onShow
}: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const headingId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const hidden = getHiddenImportableExternalWorktrees(detected)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = normalizedQuery
    ? hidden.filter(
        (worktree) =>
          worktree.displayName.toLocaleLowerCase().includes(normalizedQuery) ||
          worktree.path.toLocaleLowerCase().includes(normalizedQuery)
      )
    : hidden
  const discoveredCount = hidden.length + getVisibleNonOrcaWorktrees(detected).length
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    getItemKey: (index) => filtered[index]?.id ?? index,
    overscan: 3,
    initialRect: { width: 480, height: 224 }
  })

  if (hidden.length === 0 && listState !== 'ready') {
    return null
  }

  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id={headingId} className="text-sm font-medium">
            {translate(
              'auto.components.sidebar.WorktreeVisibilityDialog.7d21c5e848',
              'Hidden worktrees ({{value0}})',
              { value0: hidden.length }
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.HiddenWorktreeRecoveryList.64e6f53f05',
              'Show one without enabling its source.'
            )}
          </p>
        </div>
        {hidden.length >= 10 ? (
          <div className="relative w-48 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
            <Input
              type="search"
              className="h-8 pl-8 text-xs"
              value={query}
              aria-label={translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.search',
                'Search hidden worktrees'
              )}
              placeholder={translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.searchPlaceholder',
                'Search {{value0}} worktrees…',
                { value0: hidden.length }
              )}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
      </div>
      {filtered.length > 0 ? (
        <div
          ref={listRef}
          role="region"
          aria-labelledby={headingId}
          className="scrollbar-sleek max-h-56 min-w-0 overflow-y-auto"
          tabIndex={0}
          style={{ height: `${Math.min(virtualizer.getTotalSize(), 224)}px` }}
        >
          <ul className="relative min-w-0" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const worktree = filtered[virtualRow.index]
              if (!worktree) {
                return null
              }
              const displayPath = relativePathInsideRoot(repo.path, worktree.path) || worktree.path
              return (
                <li
                  key={worktree.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full pb-1"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                  aria-posinset={virtualRow.index + 1}
                  aria-setsize={filtered.length}
                >
                  <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2 hover:bg-accent/50">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{worktree.displayName}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {displayPath}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyPath !== null || toggling || listState === 'checking'}
                      aria-label={translate(
                        'auto.components.sidebar.HiddenWorktreeRecoveryList.showWorktree',
                        'Show {{value0}} at {{value1}}',
                        { value0: worktree.displayName, value1: displayPath }
                      )}
                      onClick={() => void onShow(worktree.path)}
                    >
                      {busyPath === worktree.path
                        ? translate(
                            'auto.components.sidebar.WorktreeVisibilityDialog.2f80cd4b97',
                            'Showing…'
                          )
                        : translate(
                            'auto.components.sidebar.WorktreeVisibilityDialog.e64b81d3a9',
                            'Show'
                          )}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : listState === 'ready' ? (
        <div className="flex min-h-16 items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <FolderMinus className="size-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium">
              {normalizedQuery
                ? translate(
                    'auto.components.sidebar.WorktreeVisibilityDialog.noMatches',
                    'No matching worktrees'
                  )
                : discoveredCount > 0
                  ? translate(
                      'auto.components.sidebar.WorktreeVisibilityDialog.allShown',
                      'All discovered worktrees are shown'
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeVisibilityDialog.noneFound',
                      'No non-Orca worktrees found'
                    )}
            </div>
            <div className="text-xs text-muted-foreground">
              {normalizedQuery
                ? translate(
                    'auto.components.sidebar.WorktreeVisibilityDialog.tryDifferentSearch',
                    'Try a different name or path.'
                  )
                : discoveredCount > 0
                  ? translate(
                      'auto.components.sidebar.WorktreeVisibilityDialog.disableSource',
                      'Disable a source to manage its worktrees individually.'
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeVisibilityDialog.appearWhenDetected',
                      'New worktrees will appear here when Orca detects them.'
                    )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
