import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem, GitHistoryItemRef } from '../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../shared/git-history-graph'
import { dedupeRemoteTrackingRefs } from '../../../../shared/git-history-ref-display'
import { GitHistoryGraphSvg, graphColor } from '../right-sidebar/GitHistoryGraphSvg'
import { formatGitHistoryTimestamp } from '../right-sidebar/git-history-format'
import { GitGraphWorktreeBadge } from './GitGraphWorktreeBadge'
import type { GitGraphWorktreeOverlayEntry } from './git-graph-worktree-overlay'

export const GIT_GRAPH_ROW_HEIGHT = 24

const MAX_VISIBLE_REFS = 3

function GitGraphRefPill({ itemRef }: { itemRef: GitHistoryItemRef }): React.JSX.Element {
  const refLabel = itemRef.category ? `${itemRef.name} (${itemRef.category})` : itemRef.name
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="max-w-[9rem] shrink-0 truncate rounded-full border bg-background px-1.5 py-0.5 text-[10px] leading-none"
          style={{
            borderColor: itemRef.color ? graphColor(itemRef.color) : 'var(--border)',
            color: itemRef.color ? graphColor(itemRef.color) : 'var(--muted-foreground)'
          }}
        >
          {itemRef.name}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        {refLabel}
      </TooltipContent>
    </Tooltip>
  )
}

export const GitGraphRow = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    viewModel: GitHistoryItemViewModel
    worktreeOverlay: ReadonlyMap<string, GitGraphWorktreeOverlayEntry>
    // Shared across all rows so subjects align into one column even though
    // each row's own SVG only spans its active lanes.
    laneColumnWidth: number
    onOpenCommit?: (item: GitHistoryItem) => void
  }
>(function GitGraphRow(
  { viewModel, worktreeOverlay, laneColumnWidth, onOpenCommit, className, style, ...rootProps },
  ref
): React.JSX.Element {
  const item = viewModel.historyItem
  const refs = dedupeRemoteTrackingRefs(item.references ?? [])
  const visibleRefs = refs.slice(0, MAX_VISIBLE_REFS)
  const hiddenRefs = refs.slice(MAX_VISIBLE_REFS)
  const rowTooltip = item.message || item.subject
  const timestampLabel = formatGitHistoryTimestamp(item.timestamp)

  return (
    <button
      {...rootProps}
      ref={ref}
      type="button"
      style={style}
      className={cn(
        'grid h-6 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-2 px-3 text-left text-xs transition-colors',
        onOpenCommit && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40',
        viewModel.kind === 'HEAD' && 'bg-accent/20',
        className
      )}
      data-testid="git-graph-row"
      aria-label={translate(
        'auto.components.git.graph.GitGraphRow.openCommit',
        'Open commit {{value0}}: {{value1}}',
        { value0: item.displayId ?? item.id, value1: item.subject }
      )}
      onClick={onOpenCommit ? () => onOpenCommit(item) : undefined}
    >
      <span className="shrink-0" style={{ width: laneColumnWidth }}>
        <GitHistoryGraphSvg viewModel={viewModel} />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block min-w-0 truncate text-foreground">{item.subject}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-96 whitespace-pre-wrap">
          {rowTooltip}
        </TooltipContent>
      </Tooltip>
      {refs.length > 0 ? (
        <span className="flex min-w-0 shrink items-center justify-end gap-1 overflow-hidden">
          {visibleRefs.map((itemRef) => {
            const overlayEntry =
              itemRef.category === 'branches' ? worktreeOverlay.get(itemRef.id) : undefined
            return (
              <React.Fragment key={itemRef.id}>
                {overlayEntry && <GitGraphWorktreeBadge entry={overlayEntry} />}
                <GitGraphRefPill itemRef={itemRef} />
              </React.Fragment>
            )
          })}
          {hiddenRefs.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 text-[10px] leading-none text-muted-foreground">
                  +{hiddenRefs.length}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
                {hiddenRefs.map((itemRef) => itemRef.name).join(', ')}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      ) : (
        <span />
      )}
      <span className="max-w-[9rem] shrink-0 truncate text-[11px] text-muted-foreground">
        {item.author ?? ''}
      </span>
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {timestampLabel}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        {item.displayId ?? ''}
      </span>
    </button>
  )
})
