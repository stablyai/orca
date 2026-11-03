import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function TerminalTabCloseButton({
  tabTitle,
  isActive,
  onClose
}: {
  tabTitle: string
  isActive: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <button
      className={`relative z-10 flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
        isActive
          ? 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:text-foreground focus-visible:bg-muted'
          : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted focus-visible:!text-foreground focus-visible:!bg-muted'
      }`}
      // Why: stable accessible name lets E2E drive the real close path instead of calling the store.
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
  )
}
