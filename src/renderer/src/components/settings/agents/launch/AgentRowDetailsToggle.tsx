import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'

/** The trailing chevron that shows an agent row opens; it points down while the details are open. */
export function AgentRowDetailsToggle({
  open,
  panelId,
  nameId,
  onToggle
}: {
  open: boolean
  panelId: string
  /** The agent name, so each row's chevron is announced with its agent. */
  nameId: string
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="muted-field-icon"
      size="icon-xs"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      aria-describedby={nameId}
      aria-label={
        open
          ? t('settings.agents.hideDetails', 'Hide details')
          : t('settings.agents.showDetails', 'Show details')
      }
    >
      <ChevronRight
        className={cn(
          'size-4 transition-transform duration-150 motion-reduce:transition-none',
          open && 'rotate-90'
        )}
      />
    </Button>
  )
}
