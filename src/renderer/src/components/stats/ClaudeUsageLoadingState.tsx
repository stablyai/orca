import { observeVisibleAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import { RefreshCw } from 'lucide-react'
import { SwitchIndicator } from '../ui/switch'
import { useTranslate } from '@/i18n/use-translate'

type ClaudeUsageLoadingStateProps = {
  title?: string
  summaryCardCount?: number
  summaryGridClassName?: string
}

export function ClaudeUsageLoadingState({
  title,
  summaryCardCount = 8,
  summaryGridClassName = '@md:grid-cols-2 @4xl:grid-cols-4'
}: ClaudeUsageLoadingStateProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="@container space-y-4 rounded-lg border border-border/60 bg-card/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {title ??
              t('auto.components.stats.ClaudeUsagePane.6afacbee37', 'Claude Usage Tracking')}
          </h3>
          <div
            ref={observeVisibleAnimation}
            className="mt-2 h-3 w-40 visible-animate-pulse rounded bg-muted/70"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <RefreshCw
            ref={observeVisibleAnimation}
            className="size-3.5 visible-animate-spin text-muted-foreground"
          />
          <SwitchIndicator
            checked
            className="data-[state=checked]:bg-foreground/80"
            thumbClassName="transition-none"
          />
        </div>
      </div>

      <div
        ref={observeVisibleAnimation}
        className="h-3 w-48 visible-animate-pulse rounded bg-muted/60"
      />

      <div className={`grid gap-3 ${summaryGridClassName}`}>
        {Array.from({ length: summaryCardCount }, (_, index) => (
          <div key={index} className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
            <div
              ref={observeVisibleAnimation}
              className="h-3 w-24 visible-animate-pulse rounded bg-muted/70"
            />
            <div
              ref={observeVisibleAnimation}
              className="h-7 w-20 visible-animate-pulse rounded bg-muted/60"
            />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="mb-3 space-y-2">
          <div
            ref={observeVisibleAnimation}
            className="h-4 w-24 visible-animate-pulse rounded bg-muted/70"
          />
          <div
            ref={observeVisibleAnimation}
            className="h-3 w-56 visible-animate-pulse rounded bg-muted/60"
          />
        </div>
        <div className="grid h-56 grid-cols-10 items-end gap-3">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="flex h-full flex-col justify-end gap-2">
              <div
                ref={observeVisibleAnimation}
                className="mx-auto h-3 w-10 visible-animate-pulse rounded bg-muted/60"
              />
              <div className="flex min-h-0 flex-1 items-end justify-center">
                <div
                  ref={observeVisibleAnimation}
                  className="w-full max-w-12 visible-animate-pulse rounded-t-sm bg-muted/60"
                  style={{ height: `${35 + ((index % 5) + 1) * 10}%` }}
                />
              </div>
              <div
                ref={observeVisibleAnimation}
                className="mx-auto h-3 w-12 visible-animate-pulse rounded bg-muted/60"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
