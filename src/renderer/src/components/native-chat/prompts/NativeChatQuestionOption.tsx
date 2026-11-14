import { Check } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { nativeChatQuestionOptionLabel } from './native-chat-question-option-label'

// Stable, so it runs when the preview opens rather than on every render; the option list is height-capped.
function revealPreview(element: HTMLPreElement | null): void {
  element?.scrollIntoView?.({ block: 'nearest' })
}

export function NativeChatQuestionOption({
  badge,
  label,
  description,
  preview,
  selected,
  disabled,
  onSelect,
  onEnter
}: {
  badge: string
  label: string
  description?: string
  /** Shown under the row while it is selected, as the agent wrote it. */
  preview?: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
  /** Enter on the row: the card picks it, or confirms when it is the chosen single-select row. */
  onEnter: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { shown, recommended } = nativeChatQuestionOptionLabel(label)
  return (
    // The tile wraps the row and its preview, so the preview reads as part of the picked option.
    // One root whether or not the preview shows, so selecting never remounts the focused row.
    // Focus is an outline outside the tile and picked is a ring inside it, so a focused row never reads as picked.
    <div
      className={cn(
        'rounded-[10px] outline-offset-2 outline-foreground/45 transition-colors has-[>button:focus-visible]:outline-[1.5px] has-[>button:focus-visible]:outline-solid',
        selected
          ? 'bg-accent text-accent-foreground ring-[1.5px] ring-inset ring-foreground/45'
          : 'bg-foreground/5 text-foreground has-[>button:hover]:bg-foreground/8'
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        // On the row, not the card's key hook, so Enter works when the card did not take focus;
        // preventDefault stops the native Enter click from toggling the row instead.
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
            return
          }
          event.preventDefault()
          if (
            !event.repeat &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            onEnter()
          }
        }}
        aria-pressed={selected}
        className="flex w-full items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-left focus-visible:outline-none disabled:pointer-events-none"
      >
        <span
          className={cn(
            'flex size-5.5 shrink-0 items-center justify-center rounded-md text-xs font-semibold',
            selected
              ? 'bg-primary text-primary-foreground'
              : 'bg-chat-composer-surface ring-1 ring-inset ring-question-option-border'
          )}
        >
          {selected ? <Check className="size-3.5" strokeWidth={3} /> : badge}
        </span>
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium">
            {recommended ? <span className="sr-only">{label}</span> : null}
            <span aria-hidden={recommended || undefined}>{shown}</span>
            {recommended ? (
              <span
                aria-hidden
                data-native-chat-question-recommended
                className="ml-1.5 inline-block rounded-full bg-emerald-500/16 px-1.5 align-[1px] text-2xs leading-4 font-semibold whitespace-nowrap text-emerald-700 dark:text-emerald-400"
              >
                {t('components.native-chat.question.recommended', 'Recommended')}
              </span>
            ) : null}
          </span>
          {description ? (
            <span className="mt-px block whitespace-pre-wrap break-words text-[length:calc(var(--text-sm)*13/14)] leading-snug text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      </button>
      {/* Indented to the label column (padding + badge + gap) and pulled up against the description. */}
      {preview && selected ? (
        <pre
          ref={revealPreview}
          className="-mt-2 mr-3 mb-2.5 ml-[calc(var(--spacing)*11)] max-h-56 overflow-auto whitespace-pre rounded-md bg-chat-code-surface px-2.5 py-2 font-mono text-chat-code leading-snug text-chat-foreground scrollbar-sleek"
        >
          {preview}
        </pre>
      ) : null}
    </div>
  )
}
