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
        className={cn(
          'group/option flex w-full items-start gap-3 px-3.5 py-2.5 text-left text-foreground transition-colors focus:bg-accent focus:text-accent-foreground focus:outline-none disabled:pointer-events-none',
          selected
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-accent hover:text-accent-foreground'
        )}
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium',
            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
          )}
        >
          {selected ? <Check className="size-3.5" strokeWidth={3} /> : badge}
        </span>
        <span className="min-w-0">
          <span className="block break-words text-sm">{label}</span>
          {description ? (
            <span
              className={cn(
                'block whitespace-pre-wrap break-words text-xs',
                selected
                  ? 'text-accent-foreground'
                  : 'text-muted-foreground group-hover/option:text-accent-foreground group-focus/option:text-accent-foreground'
              )}
            >
              {description}
            </span>
          ) : null}
        </span>
      </button>
      {preview && selected ? (
        <pre
          ref={revealPreview}
          className="mx-3.5 mb-2.5 max-h-56 overflow-auto whitespace-pre rounded-md border border-chat-code-border bg-chat-code-surface px-2.5 py-2 font-mono text-chat-code leading-snug text-chat-foreground scrollbar-sleek"
        >
          {preview}
        </pre>
      ) : null}
    </div>
  )
}
