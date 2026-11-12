import { cn } from '@/lib/class-names'

/** Outlined Skip until there is an answer, then a filled Submit/Next. */
export function NativeChatQuestionConfirmButton({
  label,
  answered,
  enterHint,
  disabled,
  onConfirm
}: {
  label: string
  answered: boolean
  /** Only where Enter confirms: it adds a line in a multiline answer and toggles a multi-select row. */
  enterHint: boolean
  disabled: boolean
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onConfirm}
      className={cn(
        'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg border px-3.5 text-[length:calc(var(--chat-ui-size,var(--text-sm))*13/14)] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-chat-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-chat-composer-surface disabled:cursor-default disabled:opacity-50',
        answered
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-question-option-border text-foreground hover:bg-foreground/5'
      )}
    >
      {label}
      {enterHint ? (
        <span aria-hidden className="ml-1.5 text-2xs font-medium opacity-70">
          ↵
        </span>
      ) : null}
    </button>
  )
}
