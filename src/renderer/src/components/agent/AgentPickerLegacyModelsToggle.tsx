import { ChevronRight } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

/** Row that expands the folded legacy models in place, below itself. */
export function AgentPickerLegacyModelsToggle({
  total,
  expanded,
  disabled,
  selection,
  onToggle
}: {
  total: number
  expanded: boolean
  disabled?: boolean
  /** Match the neighbouring rows' highlight style. */
  selection?: 'default' | 'palette'
  onToggle: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (total === 0) {
    return null
  }
  return (
    <CommandItem
      value="__legacy__"
      disabled={disabled}
      selection={selection}
      aria-expanded={expanded}
      onSelect={onToggle}
    >
      {t('agentPicker.moreModelsWithCount', 'More models ({{total}})', { total })}
      <ChevronRight
        className={cn(
          'ml-auto size-3.5 text-muted-foreground transition-transform',
          expanded && 'rotate-90'
        )}
      />
    </CommandItem>
  )
}
