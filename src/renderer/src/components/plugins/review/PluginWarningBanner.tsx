import { TriangleAlert, X } from 'lucide-react'
import { Button } from '../../ui/button'

/** The amber plugin notice: a bold lead word, then the body. Without onDismiss it cannot close. */
export function PluginWarningBanner({
  label,
  body,
  dismissLabel,
  onDismiss
}: {
  label: string
  body: string
  dismissLabel?: string
  onDismiss?: () => void
}): React.JSX.Element {
  return (
    <div
      role="note"
      data-dismissible={onDismiss ? '' : undefined}
      className="flex items-center gap-3 rounded-xl border border-status-warning-border bg-status-warning-background px-4 py-2 data-[dismissible]:py-1.5 data-[dismissible]:pr-1.5"
    >
      <TriangleAlert className="size-4 shrink-0 text-status-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        <span className="font-semibold text-status-warning-text">{label}</span> {body}
      </p>
      {onDismiss ? (
        <Button variant="ghost" size="icon-sm" aria-label={dismissLabel} onClick={onDismiss}>
          <X />
        </Button>
      ) : null}
    </div>
  )
}
