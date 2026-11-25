import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function AutomationRunRerunButton({
  pending,
  onRerun
}: {
  pending: boolean
  onRerun: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={onRerun}
    >
      {pending ? (
        <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
      ) : (
        <RefreshCw aria-hidden="true" className="size-3.5" />
      )}
      {t('auto.components.automations.AutomationsPage.295698292f', 'Rerun')}
    </Button>
  )
}
