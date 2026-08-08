import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function GitHistoryRefreshError({
  error,
  pending,
  onRetry
}: {
  error: string
  pending: boolean
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      aria-atomic="true"
      className="flex items-center justify-between gap-2 border-b border-border/50 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
    >
      <span className="min-w-0 break-words">{error}</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-6 shrink-0 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={pending}
        onClick={onRetry}
      >
        <RefreshCw className={pending ? 'size-3 animate-spin' : 'size-3'} />
        {translate('auto.components.right.sidebar.GitHistoryRefreshError.retry', 'Retry')}
      </Button>
    </div>
  )
}
