// @protected-copy scope=file
import type { Ref } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export type CleanupPinFailure = { before: string; name: string; after: string }

export function WorkspaceCleanupChangeFeedback({
  error,
  pinFailure,
  settling,
  disconnected,
  elementRef,
  onRetry
}: {
  error: string
  pinFailure?: CleanupPinFailure | null
  settling: boolean
  disconnected: boolean
  elementRef: Ref<HTMLParagraphElement>
  onRetry?: () => void
}) {
  const t = useTranslate()
  return (
    <p
      ref={elementRef}
      role={settling ? 'status' : 'alert'}
      tabIndex={-1}
      aria-label={pinFailure ? error : undefined}
      className={cn(
        'min-w-0 rounded-sm outline-none',
        settling ? 'text-muted-foreground' : 'text-destructive'
      )}
    >
      {pinFailure && !settling ? (
        <>
          {pinFailure.before}
          <span className="inline-block max-w-24 truncate align-bottom" title={pinFailure.name}>
            {pinFailure.name}
          </span>
          {pinFailure.after}
        </>
      ) : (
        error
      )}
      {disconnected && onRetry ? (
        <>
          {' '}
          <button type="button" className="underline" onClick={onRetry}>
            {t('components.settings.workspaceCleanup.retry', 'Try again')}
          </button>
        </>
      ) : null}
    </p>
  )
}
