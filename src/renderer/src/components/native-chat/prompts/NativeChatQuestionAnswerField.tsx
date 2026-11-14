import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import type { RefObject } from 'react'
import { Check, Pencil } from 'lucide-react'
import { cn } from '@/lib/class-names'

const LINE_BREAKS = /[\r\n\u2028\u2029]/g

/** The typed answer, filled like the option tiles; one line at rest, two while focused. */
// The field grows a line on focus; keep it in view when a short pane makes the dock scroll.
function revealGrownField(event: React.FocusEvent<HTMLTextAreaElement>): void {
  const field = event.currentTarget
  requestAnimationFrame(() => field.scrollIntoView?.({ block: 'nearest' }))
}

export function NativeChatQuestionAnswerField({
  multiline,
  value,
  chosen,
  disabled,
  takesFocus,
  placeholder,
  inputRef,
  onChange,
  onPointerChoose,
  onEnter
}: {
  multiline: boolean
  value: string
  /** The typed text is the chosen answer: the marker turns into the picked check. */
  chosen: boolean
  disabled: boolean
  /** The card has no options, so opening it focuses this field. */
  takesFocus: boolean
  placeholder: string
  inputRef?: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onPointerChoose: () => void
  onEnter: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mx-3.5 mt-2 flex shrink-0 gap-2.5 rounded-[10px] bg-foreground/5 px-3 py-2 outline-offset-2 outline-foreground/45 has-[textarea:focus-visible]:outline-[1.5px] has-[textarea:focus-visible]:outline-solid',
        multiline ? 'items-start' : 'items-center'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-5.5 shrink-0 items-center justify-center rounded-md',
          chosen ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
        )}
      >
        {chosen ? <Check className="size-3.5" strokeWidth={3} /> : <Pencil className="size-3.5" />}
      </span>
      {/* Deliver free text verbatim as a tool result; composer slash commands and autocomplete do not apply. */}
      {multiline ? (
        <ImeTextarea
          data-native-chat-answer-field
          data-native-chat-dock-content
          data-native-chat-prompt-card-focus-target={takesFocus || undefined}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onClick={onPointerChoose}
          placeholder={placeholder}
          className="scrollbar-sleek max-h-[12lh] min-h-16 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent [field-sizing:content] text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-50"
        />
      ) : (
        <ImeTextarea
          ref={inputRef}
          rows={1}
          onFocus={revealGrownField}
          data-native-chat-answer-field
          data-native-chat-dock-content
          data-native-chat-prompt-card-focus-target={takesFocus || undefined}
          disabled={disabled}
          value={value}
          // Enter submits, so a line break becomes a space; edit in place so a mid-draft paste keeps the caret.
          onChange={(e) => {
            const field = e.target
            const oneLine = field.value.replace(LINE_BREAKS, ' ')
            if (oneLine !== field.value) {
              const { selectionStart, selectionEnd } = field
              field.value = oneLine
              field.setSelectionRange(selectionStart, selectionEnd)
            }
            onChange(oneLine)
          }}
          // Select typed text on click; tabbing toward Submit must not replace a picked option.
          onClick={onPointerChoose}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnter()
            }
          }}
          placeholder={placeholder}
          className={cn(
            'scrollbar-sleek max-h-[6lh] min-h-[1lh] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground focus:min-h-[2lh] disabled:cursor-default disabled:opacity-50',
            chosen || !value ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
      )}
    </div>
  )
}
