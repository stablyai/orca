import { cn } from '@/lib/class-names'

const bar = 'shrink-0 rounded bg-muted-foreground/15'

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
            {['w-2/5', 'w-1/3', 'w-1/2', 'w-1/4', 'w-3/8'].map((width) => (
              <div key={width} className="flex h-9 items-center gap-2 px-3">
                <span className={cn(bar, 'size-3')} />
                <span className={cn(bar, 'size-3.5 rounded-full')} />
                <span className={cn(bar, 'h-2.5', width)} />
                <span className={cn(bar, 'mr-1.5 ml-auto size-3')} />
              </div>
            ))}
          </div>
          <div className="h-2 border-b border-border" />
        </>
      )}
    </div>
  )
}
