import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function PierreDiffLoading({
  error,
  onRetry,
  overlay = false
}: {
  error: string | null
  onRetry: () => void
  /** Pin over a live surface so a height-locked combined-diff row does not grow. */
  overlay?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-h-16 items-center gap-2 px-3 text-xs text-muted-foreground',
        overlay && 'absolute inset-x-0 top-0 z-10 border-b border-border bg-background'
      )}
      role="status"
    >
      <span>
        {error ?? translate('auto.components.editor.DiffSectionBody.f5cf81cec2', 'Loading diff...')}
      </span>
      {error && (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          {translate('auto.components.editor.DiffSectionBody.cef4cf0ff5', 'Retry')}
        </Button>
      )}
    </div>
  )
}
