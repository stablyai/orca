// The person's own message bubble, for their prompts and anything else they said in the chat.
import { cn } from '@/lib/class-names'

export function NativeChatUserBubble({
  className,
  variant = 'default',
  children
}: {
  className?: string
  variant?: 'default' | 'messaging'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'max-w-[80%] rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-sm text-chat-foreground-strong',
        variant === 'messaging' &&
          'rounded-2xl rounded-br-md border-transparent bg-chat-messaging-user-surface',
        className
      )}
    >
      {children}
    </div>
  )
}
