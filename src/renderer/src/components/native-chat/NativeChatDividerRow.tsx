import type { ReactNode } from 'react'

/** A quiet line across the transcript with a label in the middle. */
export function NativeChatDividerRow({
  label,
  children
}: {
  label: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 py-2 text-xs text-chat-foreground-faint"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1">{children ?? label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
