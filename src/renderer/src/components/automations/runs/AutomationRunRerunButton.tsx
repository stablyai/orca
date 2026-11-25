import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function AutomationRunRerunButton({
  pending,
  onRerun
}: {
  pending: boolean
  onRerun: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.automations.AutomationsPage.295698292f', 'Rerun')
  const icon = <RefreshCw className={cn('size-3.5', pending && 'motion-safe:animate-spin')} />
  const compact = (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={onRerun}
    >
      {icon}
    </Button>
  )

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="@max-[32.5rem]/run-header:hidden"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={onRerun}
      >
        {icon}
        {label}
      </Button>
      <div className="shrink-0 @min-[32.5rem]/run-header:hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            {pending ? <span className="inline-flex">{compact}</span> : compact}
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {label}
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}
