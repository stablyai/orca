import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function EditorFileTabCloseButton({
  fileIsDirty,
  showsSelectionChrome,
  onClose
}: {
  fileIsDirty: boolean
  showsSelectionChrome: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <button
      className={`flex items-center justify-center w-4 h-4 rounded-sm ${
        fileIsDirty
          ? 'hidden group-hover:flex text-muted-foreground hover:text-foreground hover:bg-muted'
          : showsSelectionChrome
            ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
            : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
      }`}
      type="button"
      // Why: simulator unified tabs reuse this tab chrome, so E2E needs
      // the same stable close affordance on the real button users click.
      data-tab-close-button="true"
      aria-label={translate(
        'auto.components.tab.bar.EditorFileTabCloseButton.4655cf570e',
        'Close tab'
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <X className="w-3 h-3" />
    </button>
  )
}
