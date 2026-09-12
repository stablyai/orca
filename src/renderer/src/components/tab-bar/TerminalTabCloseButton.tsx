import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

export function TerminalTabCloseButton({
  tabTitle,
  showsSelectionChrome,
  onClose
}: {
  tabTitle: string
  showsSelectionChrome: boolean
  onClose: () => void
}): React.JSX.Element {
  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const closeLabel = translate('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`relative z-10 flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
            showsSelectionChrome
              ? 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:text-foreground focus-visible:bg-muted'
              : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted focus-visible:!text-foreground focus-visible:!bg-muted'
          }`}
          // Why: stable accessible name lets E2E drive the real close path (hover, then X) instead of calling the store.
          aria-label={translate(
            'auto.components.tab.bar.SortableTab.6df69d9388',
            'Close tab {{value0}}',
            { value0: tabTitle }
          )}
          type="button"
          data-tab-close-button="true"
          onPointerDown={(e) => {
            if (e.button === 0) {
              e.stopPropagation()
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 0) {
              e.stopPropagation()
            }
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }}
        >
          <X className="w-3 h-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {closeShortcut ? `${closeLabel} (${closeShortcut})` : closeLabel}
      </TooltipContent>
    </Tooltip>
  )
}
