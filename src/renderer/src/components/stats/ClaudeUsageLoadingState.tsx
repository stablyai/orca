import { RefreshCw } from 'lucide-react'
import { SwitchIndicator } from '../ui/switch'

type ClaudeUsageLoadingStateProps = {
  title?: string
  summaryCardCount?: number
  summaryGridClassName?: string
}

export function ClaudeUsageLoadingState({
  title = 'Claude Usage Tracking',
  summaryCardCount = 8,
  summaryGridClassName = 'md:grid-cols-2 xl:grid-cols-4'
}: ClaudeUsageLoadingStateProps): React.JSX.Element {
  return (
    <div className="space-y-4 rounded-lg border border-border/60 bg-card/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <div className="mt-2 h-3 w-40 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />
          <SwitchIndicator
            checked
            className="data-[state=checked]:bg-foreground/80"
            thumbClassName="transition-none"
          />
        </div>
      </div>

      <div className="h-3 w-48 animate-pulse rounded bg-muted/60" />

      <div className={`grid gap-3 ${summaryGridClassName}`}>
        {Array.from({ length: summaryCardCount }, (_, index) => (
          <div key={index} className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
            <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
            <div className="h-7 w-20 animate-pulse rounded bg-muted/60" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="mb-3 space-y-2">
          <div className="h-4 w-24 animate-pulse rounded bg-muted/70" />
          <div className="h-3 w-56 animate-pulse rounded bg-muted/60" />
        </div>
        <div className="grid h-56 grid-cols-10 items-end gap-3">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="flex h-full flex-col justify-end gap-2">
              <div className="mx-auto h-3 w-10 animate-pulse rounded bg-muted/60" />
              <div className="flex min-h-0 flex-1 items-end justify-center">
                <div
                  className="w-full max-w-12 animate-pulse rounded-t-sm bg-muted/60"
                  style={{ height: `${35 + ((index % 5) + 1) * 10}%` }}
                />
              </div>
              <div className="mx-auto h-3 w-12 animate-pulse rounded bg-muted/60" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
