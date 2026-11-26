import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { useSidebarRowsVirtualizer } from '@/components/sidebar/worktree-list/viewport/use-virtualizer'
import { Copy } from 'lucide-react'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/class-names'
import { FileTypeIcon } from '@/components/icons/FileTypeIcon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeSearchFileMatchCount } from '../../../../../../shared/file-search/search-match-count'
import { getSearchMatchPreviewParts } from '../content-search/search-match-preview'
import { FileExplorerRowContextMenu } from '../panel/file-explorer-row-context-menu'
import type { TreeNode } from '../tree/file-explorer-types'
import type { NameMatchRowActions } from './use-name-match-row-actions'
import type { NameMatch } from './name-match-results'
import { getCombinedSearchOptionId, type CombinedSearchRow } from './combined-search-rows'
import type { CombinedSearchResultsState } from './combined-search-types'

const OVERSCAN = 12
const ROW_HEIGHT = 24
const TEXT_SECTION_GAP = 6
const TEXT_FILE_ROW_HEIGHT = 28
const MATCH_ROW_HEIGHT = 20

type ActivateRow = (index: number, permanent: boolean) => void
type ToNode = (match: NameMatch) => TreeNode | null
const noop = (): void => {}

function getRowHeight(row: CombinedSearchRow | undefined, index: number): number {
  if (!row) {
    return ROW_HEIGHT
  }
  if (row.type === 'section' && row.section === 'text' && index > 0) {
    return ROW_HEIGHT + TEXT_SECTION_GAP
  }
  if (row.type === 'file') {
    return TEXT_FILE_ROW_HEIGHT
  }
  return row.type === 'match' ? MATCH_ROW_HEIGHT : ROW_HEIGHT
}

function optionClassName(active: boolean): string {
  return cn(
    'flex w-full cursor-default items-center rounded-sm px-2 text-xs',
    // Light accent nearly matches the sidebar, so the keyboard row mixes in foreground there.
    active
      ? 'bg-foreground/10 text-foreground dark:bg-accent dark:text-accent-foreground'
      : 'hover:bg-foreground/5 dark:hover:bg-accent/50'
  )
}

/** Left mouse would move focus out of the field; opening hands focus to the editor instead. */
function keepFieldFocus(event: React.MouseEvent): void {
  if (event.button === 0) {
    event.preventDefault()
  }
}

function CopyPathMenu({
  children,
  copyValue,
  label
}: {
  children: React.ReactElement
  copyValue: string
  label: string
}): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => window.api.ui.writeClipboardText(copyValue)}>
          <Copy className="size-3.5" />
          {label}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function HighlightedName({ match }: { match: NameMatch }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const [start, end] of match.ranges) {
    if (start > cursor) {
      parts.push(match.name.slice(cursor, start))
    }
    parts.push(
      <mark key={start} className="rounded-[2px] bg-annotation-highlight/30 px-0 text-foreground">
        {match.name.slice(start, end)}
      </mark>
    )
    cursor = end
  }
  if (cursor < match.name.length) {
    parts.push(match.name.slice(cursor))
  }
  return <>{parts}</>
}

const CombinedSearchRowView = React.memo(function CombinedSearchRowView({
  row,
  index,
  active,
  onActivate,
  scopeLabel,
  rowActions,
  toNode,
  workspaceId,
  onMenuClosed
}: {
  row: CombinedSearchRow
  index: number
  active: boolean
  onActivate: ActivateRow
  scopeLabel?: string
  rowActions: NameMatchRowActions
  toNode: ToNode
  workspaceId: string | null
  onMenuClosed: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const copyPathLabel = t('auto.components.right.sidebar.SearchResultItems.3596b9668d', 'Copy Path')
  const optionProps = {
    id: getCombinedSearchOptionId(index),
    role: 'option' as const,
    'aria-selected': active,
    onMouseDown: keepFieldFocus,
    onClick: () => onActivate(index, false)
  }
  switch (row.type) {
    case 'section':
      return (
        <div
          role="presentation"
          className={cn(
            'flex h-6 select-none items-center justify-between px-2 text-2xs font-medium text-muted-foreground',
            row.section === 'text' && index > 0 && 'mt-1.5'
          )}
        >
          <span>
            {row.section === 'text'
              ? scopeLabel
                ? t('fileExplorer.combinedSearch.textInWorkspace', 'Text in workspace')
                : t('fileExplorer.combinedSearch.text', 'Text')
              : scopeLabel
                ? t('fileExplorer.combinedSearch.filesIn', 'Files in {{path}}', {
                    path: scopeLabel
                  })
                : t('fileExplorer.combinedSearch.files', 'Files')}
          </span>
          <span className="tabular-nums">{row.count}</span>
        </div>
      )
    case 'name': {
      const node = toNode(row.match)
      const content = (
        <div
          {...optionProps}
          title={row.match.relativePath}
          className={cn(optionClassName(active), 'h-6 gap-1.5')}
          draggable={node !== null}
          onDragStart={node ? (event) => rowActions.dragStart(event, node, workspaceId) : undefined}
          onDoubleClick={() => onActivate(index, true)}
        >
          <FileTypeIcon
            filePath={row.match.relativePath}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span
            className={cn(
              'min-w-0 shrink truncate',
              row.match.ignored ? 'pr-0.5 italic text-muted-foreground' : 'text-foreground'
            )}
          >
            <HighlightedName match={row.match} />
          </span>
          {row.match.dir ? (
            <span className="min-w-0 flex-1 basis-0 truncate text-2xs text-muted-foreground">
              {row.match.dir}
            </span>
          ) : null}
        </div>
      )
      if (!node) {
        return content
      }
      return (
        <ContextMenu onOpenChange={(open) => !open && onMenuClosed()}>
          <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
          <FileExplorerRowContextMenu
            node={node}
            isExpanded={false}
            deleteShortcutLabel={rowActions.deleteShortcutLabel}
            connectionId={rowActions.connectionId}
            runtimeDownloadContext={rowActions.runtimeDownloadContext}
            canOpenInOrcaBrowser={rowActions.canOpenInOrcaBrowser(node.path)}
            canCollapseFolderSubtree={false}
            targetDir={dirname(node.path)}
            targetDepth={node.depth}
            selectionSize={1}
            onViewFile={() => rowActions.open(node, false)}
            onCopyPaths={(pathKind) => rowActions.copyPaths(node, pathKind)}
            onStartNew={rowActions.startNew}
            onStartRename={rowActions.startRename}
            onDuplicate={rowActions.duplicate}
            onAddFolderAsProject={noop}
            canAddAsProject={false}
            onOpenInTerminal={noop}
            onRequestDelete={() => rowActions.requestDelete(node)}
            onCollapseFolderSubtree={noop}
            onFindInFolder={noop}
          />
        </ContextMenu>
      )
    }
    case 'show-all':
      return (
        <div
          {...optionProps}
          className={cn(
            optionClassName(active),
            'h-6',
            !active && 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('fileExplorer.combinedSearch.showAll', 'Show all {{count}}', { count: row.total })}
        </div>
      )
    case 'error':
      // A known limit reads like No results; only real failures are red.
      return row.muted ? (
        <div role="status" className="flex h-6 items-center px-2 text-xs text-muted-foreground">
          {row.message}
        </div>
      ) : (
        <div
          role="alert"
          className="whitespace-pre-wrap break-words px-2 py-1 text-xs text-destructive"
        >
          {row.message}
        </div>
      )
    case 'refine':
      return (
        <div role="status" className="flex h-6 items-center px-2 text-xs text-muted-foreground">
          {t('fileExplorer.combinedSearch.refine', 'Too many matches')}
        </div>
      )
    case 'no-results':
      return (
        <div role="status" className="flex h-6 items-center px-2 text-xs text-muted-foreground">
          {t('fileExplorer.combinedSearch.noResults', 'No results')}
        </div>
      )
    case 'file': {
      const parentDir = dirname(row.fileResult.relativePath)
      return (
        <div className="pt-1">
          <CopyPathMenu copyValue={row.fileResult.relativePath} label={copyPathLabel}>
            <div
              {...optionProps}
              aria-expanded={!row.collapsed}
              title={row.fileResult.relativePath}
              className={cn(optionClassName(active), 'h-6 gap-1.5')}
            >
              <FileTypeIcon
                filePath={row.fileResult.relativePath}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 shrink truncate text-foreground">
                {basename(row.fileResult.relativePath)}
              </span>
              <span className="min-w-0 flex-1 basis-0 truncate text-2xs text-muted-foreground">
                {parentDir === '.' ? '' : parentDir}
              </span>
              <span className="shrink-0 pl-1.5 text-2xs tabular-nums text-muted-foreground">
                {normalizeSearchFileMatchCount(row.fileResult)}
              </span>
            </div>
          </CopyPathMenu>
        </div>
      )
    }
    case 'match': {
      const parts = getSearchMatchPreviewParts(row.match)
      return (
        <CopyPathMenu
          copyValue={`${row.fileResult.relativePath}#L${row.match.line}`}
          label={t('auto.components.right.sidebar.SearchResultItems.cc06595a3b', 'Copy Line Path')}
        >
          <div
            {...optionProps}
            className={cn(optionClassName(active), 'h-5 gap-1 pl-7')}
            title={`${row.fileResult.relativePath}:${row.match.line}`}
          >
            <span className="flex min-w-0 flex-1 items-baseline overflow-hidden whitespace-pre">
              <span className="shrink-0 whitespace-pre text-muted-foreground">{parts.before}</span>
              {parts.match ? (
                <span className="max-w-full shrink-0 truncate rounded-[2px] bg-annotation-highlight/30 px-0 text-foreground">
                  {parts.match}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre text-muted-foreground">
                {parts.after}
              </span>
            </span>
          </div>
        </CopyPathMenu>
      )
    }
  }
})

/** One virtualized list for name and text results so ↑/↓ and scrolling cross both sections. */
export function CombinedSearchResults({
  model,
  activeIndex,
  listboxId,
  onActivateRow,
  scopeLabel,
  rowActions,
  toNode,
  workspaceId,
  onMenuClosed
}: CombinedSearchResultsState & {
  scopeLabel?: string
  rowActions: NameMatchRowActions
  toNode: ToNode
  workspaceId: string | null
  onMenuClosed: () => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { virtualizer, totalSize, virtualRows } = useSidebarRowsVirtualizer<HTMLDivElement>({
    count: model.count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => getRowHeight(model.getRow(index), index),
    paddingStart: 4,
    paddingEnd: 8,
    overscan: OVERSCAN,
    getItemKey: model.getKey,
    // Keep the active option mounted so aria-activedescendant never points at a recycled row.
    rangeExtractor: useCallback(
      (range: Range) => {
        const indexes = defaultRangeExtractor(range)
        return activeIndex >= 0 && !indexes.includes(activeIndex)
          ? [...indexes, activeIndex].sort((a, b) => a - b)
          : indexes
      },
      [activeIndex]
    )
  })
  // Row views stay memoized across keystrokes; only the model lookup changes underneath them.
  const latestRef = useRef({ model, onActivateRow })
  useLayoutEffect(() => {
    latestRef.current = { model, onActivateRow }
  })
  const activate = useCallback<ActivateRow>((index, permanent) => {
    const { model: current, onActivateRow: activateRow } = latestRef.current
    const row = current.getRow(index)
    if (row) {
      activateRow(row, index, permanent)
    }
  }, [])

  useEffect(() => {
    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, virtualizer])

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
      data-combined-search-results=""
    >
      <div id={listboxId} role="listbox" className="relative w-full" style={{ height: totalSize }}>
        {virtualRows.map((item) => {
          const row = model.getRow(item.index)
          if (!row) {
            return null
          }
          return (
            <div
              key={item.key}
              // A wrapped error must push later rows down, so rows are measured, not only estimated.
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-2 right-2 top-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <CombinedSearchRowView
                row={row}
                index={item.index}
                active={item.index === activeIndex}
                onActivate={activate}
                scopeLabel={scopeLabel}
                rowActions={rowActions}
                toNode={toNode}
                workspaceId={workspaceId}
                onMenuClosed={onMenuClosed}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
