import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { VirtualizedList } from '@/components/ui/virtualized-list'
import { useTranslate } from '@/i18n/use-translate'
import type {
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../../shared/git/history/git-history-types'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git/history/git-history-graph'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { SourceControlRowOpenEvent } from '../listing/split-open'
import { GitHistoryRow } from './git-history-row'
import { GitHistoryCommitFiles, type GitHistoryCommitFilesState } from './git-history-commit-files'
import {
  GitHistoryCommitContextMenu,
  type GitHistoryCommitAction
} from './git-history-commit-context-menu'

export type GitHistoryListActions = {
  onOpenCommit?: (item: GitHistoryItem) => void
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  onOpenCommitFile?: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  onCommitAction?: (action: GitHistoryCommitAction, item: GitHistoryItem) => void
  onLoadMore?: () => void
}

const rowKey = (row: GitHistoryItemViewModel): string => `${row.kind}:${row.historyItem.id}`

export function GitHistoryList({
  result,
  viewModels,
  height,
  isLoadingMore,
  loadMoreError,
  refreshing,
  paginationPaused,
  onLoadMore,
  onOpenCommit,
  onLoadCommitFiles,
  onOpenCommitFile,
  onCommitAction
}: GitHistoryListActions & {
  result: GitHistoryResult
  viewModels: GitHistoryItemViewModel[]
  height: string
  isLoadingMore?: boolean
  loadMoreError?: string
  refreshing: boolean
  paginationPaused?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  // Why: the reset effect below mutates the node, so it reads a ref; the state only feeds rendering.
  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const setScrollRefs = useCallback((element: HTMLDivElement | null) => {
    scrollElementRef.current = element
    setScrollElement(element)
  }, [])
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filesByCommit, setFilesByCommit] = useState<Record<string, GitHistoryCommitFilesState>>({})
  // Appending a page keeps the first item object; a refresh replaces it.
  const identity = result.items[0]
  const [historyIdentity, setHistoryIdentity] = useState(identity)
  const fileSessionRef = useRef({ identity, ids: new Set<string>() })
  if (historyIdentity !== identity) {
    setHistoryIdentity(identity)
    setExpanded(new Set())
    setFilesByCommit({})
  }
  useEffect(() => {
    fileSessionRef.current = { identity, ids: new Set() }
    const element = scrollElementRef.current
    if (element) {
      element.scrollTop = 0
    }
  }, [identity])

  const canLoad = Boolean(onLoadMore)
  const pagingDisabled = refreshing || paginationPaused
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (
      !scrollElement ||
      !sentinel ||
      !canLoad ||
      isLoadingMore ||
      loadMoreError ||
      pagingDisabled
    ) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore?.()
        }
      },
      { root: scrollElement, rootMargin: '0px 0px 200px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    scrollElement,
    canLoad,
    isLoadingMore,
    loadMoreError,
    pagingDisabled,
    onLoadMore,
    result.items.length
  ])

  const handleToggleExpand = useCallback(
    (item: GitHistoryItem): void => {
      const willExpand = !expanded.has(item.id)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (willExpand) {
          next.add(item.id)
        } else {
          next.delete(item.id)
        }
        return next
      })
      const session = fileSessionRef.current
      if (!willExpand || !onLoadCommitFiles || session.ids.has(item.id)) {
        return
      }
      session.ids.add(item.id)
      setFilesByCommit((prev) => ({ ...prev, [item.id]: { status: 'loading' } }))
      void onLoadCommitFiles(item)
        .then((entries) => {
          if (fileSessionRef.current !== session) {
            return
          }
          setFilesByCommit((prev) => ({ ...prev, [item.id]: { status: 'ready', entries } }))
        })
        .catch((error: unknown) => {
          if (fileSessionRef.current !== session) {
            return
          }
          session.ids.delete(item.id)
          setFilesByCommit((prev) => ({
            ...prev,
            [item.id]: {
              status: 'error',
              error: error instanceof Error ? error.message : 'Failed to load commit files'
            }
          }))
        })
    },
    [expanded, onLoadCommitFiles]
  )

  return (
    <div
      ref={setScrollRefs}
      className="overflow-y-auto scrollbar-sleek"
      style={{ height }}
      aria-label={t('source-control.history.label', 'Commit history')}
      aria-busy={isLoadingMore || refreshing}
    >
      <VirtualizedList
        rows={viewModels}
        getRowKey={rowKey}
        scrollElement={scrollElement}
        estimateRowHeightPx={24}
        announceListPosition
        hasUnloadedRows={result.hasMore}
        renderRow={(viewModel) => {
          const item = viewModel.historyItem
          const isBoundary =
            viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
          const canExpand = !isBoundary && Boolean(onLoadCommitFiles) && Boolean(onOpenCommitFile)
          const isExpanded = canExpand && expanded.has(item.id)
          const row = (
            <GitHistoryRow
              viewModel={viewModel}
              expanded={isExpanded}
              preserveRefIds={result.baseRef ? [result.baseRef.id] : undefined}
              onOpenCommit={onOpenCommit}
              onToggleExpand={canExpand ? handleToggleExpand : undefined}
            />
          )
          return (
            <div key={rowKey(viewModel)}>
              {onCommitAction && !isBoundary ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                  <GitHistoryCommitContextMenu item={item} onAction={onCommitAction} />
                </ContextMenu>
              ) : (
                row
              )}
              {isExpanded && (
                <GitHistoryCommitFiles
                  state={filesByCommit[item.id] ?? { status: 'loading' }}
                  author={item.author}
                  timestamp={item.timestamp}
                  onOpenFile={(entry, event) => onOpenCommitFile?.(item, entry, event)}
                  onOpenAll={onOpenCommit ? () => onOpenCommit(item) : undefined}
                />
              )}
            </div>
          )
        }}
      />
      <div ref={sentinelRef} className="px-3 py-2 text-xs text-muted-foreground">
        {loadMoreError && (
          <p role="alert" className="text-destructive">
            {loadMoreError}
          </p>
        )}
        {isLoadingMore ? (
          <span role="status" className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            {t('source-control.history.loading-more', 'Loading more commits…')}
          </span>
        ) : canLoad ? (
          <Button variant="ghost" size="xs" disabled={pagingDisabled} onClick={onLoadMore}>
            {loadMoreError
              ? t('source-control.history.retry', 'Retry loading commits')
              : t('source-control.history.load-more', 'Load more commits')}
          </Button>
        ) : result.hasMore ? (
          <p>
            {t(
              'source-control.history.update-host',
              'Restart Orca or update the execution host to load older commits.'
            )}
          </p>
        ) : (
          <span>{t('source-control.history.all-loaded', 'All commits loaded')}</span>
        )}
      </div>
    </div>
  )
}
