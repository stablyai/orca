import { ChevronDown, ChevronUp } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/** Trailing row of a group capped by Sessions per group; reveals or re-hides the rest. */
export function AiVaultGroupMoreRow({
  hiddenCount,
  expanded,
  onToggle
}: {
  hiddenCount: number
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const Icon = expanded ? ChevronUp : ChevronDown
  return (
    <button
      type="button"
      className="flex h-7 w-full items-center gap-1.5 border-b border-sidebar-border px-3 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <Icon className="size-3 shrink-0" />
      {expanded
        ? translate('auto.components.right.sidebar.AiVaultGroupMoreRow.showFewer', 'Show fewer')
        : translate(
            'auto.components.right.sidebar.AiVaultGroupMoreRow.showMore',
            'Show {{value0}} more',
            { value0: hiddenCount.toLocaleString() }
          )}
    </button>
  )
}
