import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'

export function EditorFileTabRenameInput({
  fileName,
  inputRef,
  onCommit,
  onCancel
}: {
  fileName: string
  inputRef: (input: HTMLInputElement | null) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Input
      ref={inputRef}
      data-tab-rename-input="true"
      aria-label={translate(
        'auto.components.tab.bar.EditorFileTab.3da7445c84',
        'Rename file {{value0}}',
        { value0: fileName }
      )}
      defaultValue={fileName}
      className="mr-1 h-5 min-w-0 flex-1 rounded-sm bg-input/40 px-1 py-0 text-xs text-foreground md:text-xs focus-visible:ring-[1px]"
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (isImeCompositionKeyDown(e)) {
          return
        }
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Enter') {
            onCommit()
          } else {
            onCancel()
          }
        }
      }}
      onBlur={onCommit}
    />
  )
}
