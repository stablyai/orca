import { Input } from '@/components/ui/input'
import { basename } from '@/lib/path'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'

export function EditorFileTabRenameInput({
  filePath,
  setInputElement,
  onCommit,
  onCancel
}: {
  filePath: string
  setInputElement: (input: HTMLInputElement | null) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Input
      ref={setInputElement}
      data-tab-rename-input="true"
      aria-label={translate(
        'auto.components.tab.bar.EditorFileTab.3da7445c84',
        'Rename file {{value0}}',
        { value0: basename(filePath) }
      )}
      defaultValue={basename(filePath)}
      // Why: keep the inline field compact enough for the titlebar while
      // giving filenames a little more room than the static tab label.
      className="mr-1 h-5 w-[12ch] min-w-[72px] max-w-[132px] rounded-sm bg-input/40 px-1 py-0 text-xs text-foreground md:text-xs focus-visible:ring-[1px]"
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Why: an Enter that only confirms a CJK IME candidate must not
        // commit the rename; wait for a non-composition Enter.
        if (isImeCompositionKeyDown(e)) {
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
      onBlur={onCommit}
    />
  )
}
