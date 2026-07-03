import React from 'react'
import { ChevronDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { GitHistoryItem, GitHistoryItemRef } from '../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../shared/git-history-graph'
import { GitHistoryGraphSvg, graphColor } from './GitHistoryGraphSvg'
import { dedupeRemoteTrackingRefs } from '../../../../shared/git-history-ref-display'
import { translate } from '@/i18n/i18n'

function GitHistoryRefBadge({ itemRef }: { itemRef: GitHistoryItemRef }): React.JSX.Element {
  const refLabel = itemRef.category ? `${itemRef.name} (${itemRef.category})` : itemRef.name

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="max-w-[8rem] truncate rounded-full border bg-sidebar px-1.5 py-0.5 text-[10px] leading-none"
          style={{
            borderColor: itemRef.color ? graphColor(itemRef.color) : 'var(--border)',
            color: itemRef.color ? graphColor(itemRef.color) : 'var(--muted-foreground)'
          }}
          title={itemRef.name}
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

type GitHistoryRowProps = React.HTMLAttributes<HTMLElement> & {
  viewModel: GitHistoryItemViewModel
  expanded?: boolean
  preserveRefIds?: readonly string[]
  // 'pane' is the wide full-pane Git Graph layout (adds author + short-hash
  // columns); 'sidebar' (default) keeps the original narrow row unchanged.
  layout?: 'sidebar' | 'pane'
  onOpenCommit?: (item: GitHistoryItem) => void
  onToggleExpand?: (item: GitHistoryItem) => void
}

export const GitHistoryRow = React.forwardRef<HTMLElement, GitHistoryRowProps>(
  function GitHistoryRow(
    {
      viewModel,
      expanded = false,
      preserveRefIds,
      layout = 'sidebar',
      onOpenCommit,
      onToggleExpand,
      className,
      ...rootProps
    },
    ref
  ): React.JSX.Element {
    const isPaneLayout = layout === 'pane'
    const item = viewModel.historyItem
    const isBoundaryNode =
      viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
    // Expanding to an inline file list is the primary click; opening the combined
    // diff stays reachable from the expanded list. Fall back to open-all when no
    // expand handler is wired so the row still does something useful.
    const canExpand = !isBoundaryNode && Boolean(onToggleExpand)
    const canOpenCommit = !isBoundaryNode && Boolean(onOpenCommit)
    const isInteractive = canExpand || canOpenCommit
    // A local branch and its own remote-tracking ref at the same commit are
    // redundant, so collapse the pair to one pill.
    const refs = dedupeRemoteTrackingRefs(item.references ?? [], { preserveRefIds })
    const visibleRefs = refs.slice(0, 2)
    const hiddenRefs = refs.slice(2)
    const rowTooltip = item.message || item.subject
    const rowClassName = cn(
      'grid min-h-[26px] w-full min-w-0 items-center gap-x-1.5 px-3 py-0.5 text-left text-xs transition-colors',
      // Pane adds author + short-hash trailing columns; sidebar keeps the
      // original 3-column (graph | subject | refs) template byte-identical.
      isPaneLayout
        ? 'grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]'
        : 'grid-cols-[auto_minmax(0,1fr)_auto]',
      isInteractive && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40',
      !isInteractive && 'cursor-default',
      isBoundaryNode && 'text-muted-foreground',
      className
    )
    const rowContent = (
      <>
        {isPaneLayout ? (
          // Cap the graph column and scroll within it so a many-lane repo-wide
          // graph can't push the subject/author/hash columns out of alignment.
          <div className="max-w-[200px] overflow-x-auto scrollbar-none">
            <GitHistoryGraphSvg viewModel={viewModel} />
          </div>
        ) : (
          <GitHistoryGraphSvg viewModel={viewModel} />
        )}
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {canExpand && (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                !expanded && '-rotate-90'
              )}
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block min-w-0 flex-1 truncate text-foreground" title={rowTooltip}>
                {item.subject}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="max-w-96 whitespace-pre-wrap">
              {rowTooltip}
            </TooltipContent>
          </Tooltip>
        </div>
        {(refs.length > 0 || isPaneLayout) && (
          <div className="flex shrink-0 items-center gap-1 overflow-hidden">
            {visibleRefs.map((ref) => (
              <GitHistoryRefBadge key={ref.id} itemRef={ref} />
            ))}
            {hiddenRefs.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="shrink-0 text-[10px] leading-none text-muted-foreground"
                    title={hiddenRefs.map((ref) => ref.name).join(', ')}
                  >
                    +{hiddenRefs.length}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
                  {hiddenRefs.map((ref) => ref.name).join(', ')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
        {isPaneLayout && (
          <span
            className="ml-2 max-w-[10rem] shrink-0 truncate text-right text-[11px] text-muted-foreground"
            title={item.author}
          >
            {item.author}
          </span>
        )}
        {isPaneLayout && (
          <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
            {item.displayId}
          </span>
        )}
      </>
    )

    if (!isInteractive) {
      return (
        <div
          {...rootProps}
          ref={ref as React.Ref<HTMLDivElement>}
          className={rowClassName}
          title={rowTooltip}
          data-testid="git-history-row"
        >
          {rowContent}
        </div>
      )
    }

    const handleClick = (): void => {
      if (canExpand) {
        onToggleExpand?.(item)
        return
      }
      onOpenCommit?.(item)
    }

    return (
      <button
        {...rootProps}
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        className={rowClassName}
        title={rowTooltip}
        aria-expanded={canExpand ? expanded : undefined}
        aria-label={
          canExpand
            ? expanded
              ? translate(
                  'auto.components.right.sidebar.GitHistoryRow.4a8d9e0c1f',
                  'Hide files in commit {{value0}}: {{value1}}',
                  { value0: item.displayId ?? item.id, value1: item.subject }
                )
              : translate(
                  'auto.components.right.sidebar.GitHistoryRow.2f9c41ab07',
                  'Show files in commit {{value0}}: {{value1}}',
                  { value0: item.displayId ?? item.id, value1: item.subject }
                )
            : translate(
                'auto.components.right.sidebar.GitHistoryPanel.8232c8b2f2',
                'Open commit {{value0}}: {{value1}}',
                { value0: item.displayId ?? item.id, value1: item.subject }
              )
        }
        data-testid="git-history-row"
        onClick={handleClick}
      >
        {rowContent}
      </button>
    )
  }
)
