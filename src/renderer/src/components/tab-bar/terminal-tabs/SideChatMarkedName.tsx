import { MessageSquare } from 'lucide-react'

export function SideChatMarkedName({ name, mark }: { name: string; mark: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="sr-only">{mark} </span>
      <MessageSquare
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground @min-[10rem]/tab:hidden group-data-[side-chat-only=true]/side-chat-pane:hidden"
      />
      <span
        aria-hidden
        className="hidden shrink-0 rounded-sm border border-border bg-muted px-1 text-3xs font-medium text-muted-foreground @min-[10rem]/tab:inline-flex group-data-[side-chat-only=true]/side-chat-pane:hidden"
      >
        {mark}
      </span>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}
