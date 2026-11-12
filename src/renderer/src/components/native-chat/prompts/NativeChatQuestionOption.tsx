import { Check } from 'lucide-react'
import { cn } from '@/lib/class-names'

// Stable, so it runs when the preview opens rather than on every render; the option list is height-capped.
function revealPreview(element: HTMLPreElement | null): void {
  element?.scrollIntoView?.({ block: 'nearest' })
}

export function NativeChatQuestionOption({
  badge,
  initialFocus,
  label,
  description,
  preview,
  selected,
  disabled,
  onSelect
}: {
  badge: string
  initialFocus: boolean
  label: string
  description?: string
  /** Shown under the row while it is selected, as the agent wrote it. */
  preview?: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    // One root whether or not the preview shows, so selecting never remounts the focused row.
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        aria-pressed={selected}
        data-native-chat-prompt-card-focus-target={initialFocus || undefined}
        // Focus is an inset ring, never the selected fill, so the row that opens focused does not read as picked.
        className={cn(
          'flex w-full items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-chat-focus-ring disabled:pointer-events-none',
          selected
            ? 'border-primary bg-foreground/8'
            : 'border-question-option-border hover:bg-foreground/5'
        )}
      >
        <span
          className={cn(
            'flex size-5.5 shrink-0 items-center justify-center rounded-md border text-xs font-medium',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-question-option-border text-foreground'
          )}
        >
          {selected ? <Check className="size-3.5" strokeWidth={3} /> : badge}
        </span>
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium">{label}</span>
          {description ? (
            <span className="mt-px block whitespace-pre-wrap break-words text-[length:calc(var(--text-sm)*13/14)] leading-snug text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      </button>
      {preview && selected ? (
        <pre
          ref={revealPreview}
          className="mt-1.5 max-h-56 overflow-auto whitespace-pre rounded-md border border-chat-code-border bg-chat-code-surface px-2.5 py-2 font-mono text-chat-code leading-snug text-chat-foreground scrollbar-sleek"
        >
          {preview}
        </pre>
      ) : null}
    </div>
  )
}
