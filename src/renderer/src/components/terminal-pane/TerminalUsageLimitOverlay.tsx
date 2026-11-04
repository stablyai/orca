import { useId, useState } from 'react'
import { Gauge, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Uses the phone-control card's pane-local surface without taking keyboard focus from the CLI. */
export function TerminalUsageLimitOverlay({
  title,
  body,
  pending,
  onContinue,
  actionDisabled = false
}: {
  title: string
  body: string
  pending: boolean
  onContinue?: () => void
  actionDisabled?: boolean
}): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const minimize = translate('terminal.usageLimit.minimize', 'Minimize')
  const continueLabel = translate('terminal.usageLimit.continue', 'Continue now')
  if (collapsed) {
    return (
      <div className="absolute right-2 top-2 z-40 flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground shadow-xs">
        <Gauge className="size-3 shrink-0" aria-hidden="true" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="min-w-0 shrink px-1"
          onClick={() => setCollapsed(false)}
        >
          <span className="truncate">{title}</span>
        </Button>
        {onContinue ? (
          <Button type="button" size="xs" disabled={pending || actionDisabled} onClick={onContinue}>
            {continueLabel}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="terminal-usage-limit-overlay pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-6">
      <section
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="pointer-events-auto relative flex max-h-full w-full max-w-sm gap-3 overflow-auto scrollbar-sleek rounded-lg border border-border bg-card p-4 text-card-foreground shadow-floating"
      >
        <Gauge className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div id={titleId} className="pr-6 text-sm font-semibold leading-5">
            {title}
          </div>
          <div
            id={bodyId}
            role="status"
            className="mt-0.5 whitespace-pre-line break-words text-sm text-muted-foreground"
          >
            {body}
          </div>
          {onContinue ? (
            <div className="mt-3 flex flex-wrap justify-end gap-1.5">
              <Button
                type="button"
                size="sm"
                disabled={pending || actionDisabled}
                aria-busy={pending}
                onClick={onContinue}
              >
                {continueLabel}
              </Button>
            </div>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-2 top-2"
              aria-label={minimize}
              onClick={() => setCollapsed(true)}
            >
              <Minimize2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {minimize}
          </TooltipContent>
        </Tooltip>
      </section>
    </div>
  )
}
