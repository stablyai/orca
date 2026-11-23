import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'

/** A transcript card with optional avatar, heading, state, title, body and action slots. */
export function NativeChatCardFrame({
  avatar,
  heading,
  status,
  trailing,
  className,
  headingClassName,
  title,
  footer,
  label,
  children
}: {
  avatar?: ReactNode
  /** What kind of card and where it acts; wraps, never truncates. */
  heading?: ReactNode
  /** The card's state, as a `NativeChatCardStatus`. */
  status?: ReactNode
  trailing?: ReactNode
  className?: string
  headingClassName?: string
  title?: ReactNode
  /** The action bar, as `NativeChatCardActions`. */
  footer?: ReactNode
  /** Names the card for screen readers when its title isn't plain text. */
  label?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      // Same fill as the user's own messages, so cards read as one family on every chat palette.
      className={cn(
        '@container/card w-full min-w-0 rounded-xl border border-border bg-[color-mix(in_srgb,var(--chat-source-foreground)_var(--chat-user-mix),var(--chat-canvas))] text-sm text-card-foreground shadow-xs',
        className
      )}
    >
      <div className="flex gap-3 p-3">
        {avatar}
        <div className="min-w-0 flex-1">
          {heading || status || trailing ? (
            // A long state or translation wraps under the kind line rather than being cut off.
            <div
              className={cn(
                'flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground',
                headingClassName
              )}
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{heading}</span>
              {status || trailing ? (
                <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5">
                  {status}
                  {trailing}
                </div>
              ) : null}
            </div>
          ) : null}
          {title ? (
            <div className="font-semibold text-foreground [overflow-wrap:anywhere]">{title}</div>
          ) : null}
          {children}
        </div>
      </div>
      {footer ? <div className="border-t border-border px-3 py-2">{footer}</div> : null}
    </div>
  )
}

const STATUS_TONE = {
  success: 'text-status-success',
  warning: 'text-status-warning-text',
  muted: 'text-muted-foreground'
} as const

/** A card's state as a dot and a word; the word carries the meaning, the colour only repeats it. */
export function NativeChatCardStatus({
  tone,
  children
}: {
  tone: keyof typeof STATUS_TONE
  children: ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 font-semibold [overflow-wrap:anywhere]',
        STATUS_TONE[tone]
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  )
}

/** A card's action bar: quiet controls on the left, then secondary buttons and at most one filled
 *  primary on the right. In a narrow card the right-hand buttons share the row; labels too long for
 *  it wrap onto more lines or stack instead of being cut off. Focus rings use the chat's ring at full
 *  strength, as the chat styleguide asks, so they clear 3:1 on the card's fill. */
export function NativeChatCardActions({
  start,
  children
}: {
  start?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-ring">
      {start}
      {children ? (
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 *:h-auto *:min-h-8 *:max-w-full *:py-1.5 *:whitespace-normal @max-[420px]/card:w-full @max-[420px]/card:*:flex-1">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function NativeChatCardAvatar({
  children,
  className,
  compact = false
}: {
  children: ReactNode
  className?: string
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full border border-border bg-muted',
        compact ? 'size-6' : 'mt-0.5 size-8',
        className
      )}
    >
      {children}
    </div>
  )
}
