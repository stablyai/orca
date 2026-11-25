import { cn } from '@/lib/class-names'

/** A strip in the rows above the composer (thread goal, temporary worker, MCP tray), on their shared edges. */
export function NativeChatComposerTabStrip({
  children,
  layout = 'row',
  ...dataAttributes
}: {
  children: React.ReactNode
  /** `row` lays out one padded line; `stack` leaves the children to lay out a header and body. */
  layout?: 'row' | 'stack'
} & Record<`data-${string}`, string>): React.JSX.Element {
  return (
    // A dock row like the queue: the same edges, and its own 8px top gap.
    <div
      className="relative shrink-0 bg-chat-pane px-3 pt-2 sm:px-4"
      data-native-chat-composer-tab-strip=""
      {...dataAttributes}
    >
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <div
          className={cn(
            'rounded-lg border border-border bg-muted/30 text-xs text-muted-foreground',
            layout === 'row' ? 'flex items-start gap-2 py-1 pr-1 pl-3' : 'flex flex-col'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
