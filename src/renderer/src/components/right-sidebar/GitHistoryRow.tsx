import type React from 'react'
import type { GitHistoryItem, GitHistoryItemRef } from '../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../shared/git-history-graph'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { GitHistoryGraphSvg, graphColor } from './GitHistoryGraphSvg'
import { formatGitHistoryTimestamp } from './git-history-format'

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

export function GitHistoryRow({
  viewModel,
  onOpenCommit
}: {
  viewModel: GitHistoryItemViewModel
  onOpenCommit?: (item: GitHistoryItem) => void
}): React.JSX.Element {
  const item = viewModel.historyItem
  const timestamp = formatGitHistoryTimestamp(item.timestamp)
  const isBoundaryNode =
    viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
  const canOpenCommit = !isBoundaryNode && Boolean(onOpenCommit)
  const refs = item.references ?? []
  const visibleRefs = refs.slice(0, 2)
  const hiddenRefs = refs.slice(2)
  const rowTooltip = item.message || item.subject
  const rowClassName = cn(
    'grid min-h-[34px] w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_4.5rem_3.25rem_3.75rem] grid-rows-[auto_auto] items-start gap-x-1.5 px-3 py-1 text-left text-xs transition-colors',
    canOpenCommit && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40',
    !canOpenCommit && 'cursor-default',
    isBoundaryNode && 'text-muted-foreground'
  )
  const rowContent = (
    <>
      <div className="row-span-2">
        <GitHistoryGraphSvg viewModel={viewModel} />
      </div>
      <div className="min-w-0 overflow-hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block min-w-0 truncate text-foreground" title={rowTooltip}>
              {item.subject}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="max-w-96 whitespace-pre-wrap">
            {rowTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      {item.author ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="min-w-0 truncate text-right text-[11px] leading-4 text-muted-foreground"
              title={item.author}
            >
              {item.author}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-all">
            {item.author}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="min-w-0 truncate text-right text-[11px] leading-4 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate text-right text-[11px] leading-4 text-muted-foreground">
        {timestamp}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-[10px] leading-4 text-muted-foreground">
        {!isBoundaryNode ? item.displayId : ''}
      </span>
      <div className="col-span-4 col-start-2 min-w-0 overflow-hidden">
        {refs.length > 0 && (
          <div className="mt-0.5 flex h-3.5 min-w-0 items-center gap-1 overflow-hidden">
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
      </div>
    </>
  )

  if (!canOpenCommit) {
    return (
      <div className={rowClassName} title={rowTooltip} data-testid="git-history-row">
        {rowContent}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={rowClassName}
      title={rowTooltip}
      aria-label={translate(
        'auto.components.right.sidebar.GitHistoryPanel.8232c8b2f2',
        'Open commit {{value0}}: {{value1}}',
        { value0: item.displayId ?? item.id, value1: item.subject }
      )}
      data-testid="git-history-row"
      onClick={() => {
        onOpenCommit?.(item)
      }}
    >
      {rowContent}
    </button>
  )
}
