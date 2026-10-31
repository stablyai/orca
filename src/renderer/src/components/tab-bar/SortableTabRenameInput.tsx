import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

export function SortableTabRenameInput({
  inputRef,
  value,
  tabTitle,
  onValueChange,
  onCommit,
  onKeyDown
}: {
  inputRef: (element: HTMLInputElement | null) => void
  value: string
  tabTitle: string
  onValueChange: (value: string) => void
  onCommit: () => void
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>
}): React.JSX.Element {
  return (
    <Input
      ref={inputRef}
      data-tab-rename-input="true"
      value={value}
      aria-label={translate(
        'auto.components.tab.bar.SortableTab.ab19f603eb',
        'Rename tab {{value0}}',
        { value0: tabTitle }
      )}
      onChange={(event) => onValueChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={onKeyDown}
      // Why: stop bubbling so clicking inside the input doesn't activate the tab or start a dnd-kit drag.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        // Why: stopPropagation avoids outer tab activation/drag; preventDefault on middle-click blocks Linux X11 paste.
        event.stopPropagation()
        if (event.button === 1) {
          event.preventDefault()
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
      // Why: base Input's min-w-0 lets flex shrink it to ~0 in a saturated tab bar; force a usable minimum width.
      className="mr-1 h-5 min-w-[72px] flex-1 px-1 py-0 text-xs"
      spellCheck={false}
    />
  )
}
