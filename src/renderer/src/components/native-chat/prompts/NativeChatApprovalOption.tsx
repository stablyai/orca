import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/class-names'

type NativeChatApprovalOptionProps = {
  label: string
  /** The card's default answer: filled, and focused as the card opens. */
  primary: boolean
  /** A sign-in request's secondary answer reads as a quiet link. */
  urlRequest: boolean
  quiet: boolean
  disabled: boolean
  sending: boolean
  onClick: () => void
}

export function NativeChatApprovalOption({
  label,
  primary,
  urlRequest,
  quiet,
  disabled,
  sending,
  onClick
}: NativeChatApprovalOptionProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-native-chat-prompt-card-focus-target={primary || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        quiet ? 'h-6 px-2.5 text-xs font-medium' : 'px-4 py-1.5 text-sm font-semibold',
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : urlRequest
            ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            : quiet
              ? 'bg-chat-foreground/5 text-chat-foreground hover:bg-chat-foreground/10'
              : 'border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {sending ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {label}
        </span>
      ) : (
        label
      )}
    </button>
  )
}
