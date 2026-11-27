import { cn } from '@/lib/class-names'

const bar = 'shrink-0 rounded bg-muted-foreground/15'
// Why: on card surfaces light theme needs a step more contrast; dark keeps the panel shade.
const cardBar = 'shrink-0 rounded bg-muted-foreground/20 dark:bg-muted-foreground/15'
const ROW_WIDTHS = ['w-2/5', 'w-1/3', 'w-1/2', 'w-1/4', 'w-3/8']

/**
 * Placeholder check rows: chevron, status icon, name, and a trailing icon (panel) or status label (PR page).
 * Shared by the checks panel and the PR page/dialog Checks tabs so their skeletons stay one shape.
 */
export function CheckRowsLoading({
  rowClassName = 'h-9 px-3',
  trailing = 'icon',
  onCard = false,
  divided = false
}: {
  rowClassName?: string
  trailing?: 'icon' | 'label'
  onCard?: boolean
  divided?: boolean
}): React.JSX.Element {
  const shade = onCard ? cardBar : bar
  return (
    <>
      {ROW_WIDTHS.map((width, index) => (
        <div
          key={width}
          className={cn(
            'flex items-center gap-2',
            rowClassName,
            divided && index > 0 && 'box-content border-t border-border/40'
          )}
        >
          <span className={cn(shade, 'size-3')} />
          <span className={cn(shade, 'size-3.5 rounded-full')} />
          <span className={cn(shade, 'h-2.5', width)} />
          {trailing === 'icon' ? (
            <span className={cn(shade, 'mr-1.5 ml-auto size-3')} />
          ) : (
            <span className={cn(shade, 'ml-auto h-2 w-10')} />
          )}
        </div>
      ))}
    </>
  )
}

export function ChecksListLoading({
  expanded,
  detailsHeight
}: {
  expanded: boolean
  detailsHeight: number
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="animate-in fade-in-0 fill-mode-backwards delay-150 motion-reduce:animate-none"
    >
      <div className="flex h-8 items-center gap-3 border-b border-border px-3">
        <span className={cn(bar, 'size-3')} />
        <span className={cn(bar, 'h-2 w-14')} />
        <span className={cn(bar, 'h-2 w-12')} />
      </div>
      {expanded && (
        <>
          <div className="overflow-hidden py-1" style={{ maxHeight: detailsHeight }}>
            <CheckRowsLoading />
          </div>
          <div className="h-2 border-b border-border" />
        </>
      )}
    </div>
  )
}
