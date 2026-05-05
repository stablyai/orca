import { MessageSquare, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { defaultChatId } from '../../../shared/chat-id'

export default function ChatSwitcher({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const worktree = useAppStore((s) =>
    Object.values(s.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
  )
  const activeChatId = useAppStore(
    (s) => s.activeChatIdByWorktreeId[worktreeId] ?? defaultChatId(worktreeId)
  )
  const switchChat = useAppStore((s) => s.switchChat)
  const createChat = useAppStore((s) => s.createChat)
  const chats = worktree?.chats ?? [
    { id: defaultChatId(worktreeId), title: 'Chat 1', createdAt: 0, updatedAt: 0 }
  ]

  if (chats.length <= 1) {
    return null
  }

  return (
    <div
      data-testid="chat-switcher"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-2"
    >
      <MessageSquare className="size-3.5 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {chats.map((chat, index) => (
          <button
            key={chat.id}
            type="button"
            data-testid="chat-switcher-item"
            data-chat-id={chat.id}
            data-active={chat.id === activeChatId}
            className={cn(
              'h-6 shrink-0 rounded px-2 text-[11px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground',
              chat.id === activeChatId && 'bg-accent text-foreground'
            )}
            onClick={() => switchChat(worktreeId, chat.id)}
            title={`${chat.title} (${navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+'}${index + 1})`}
          >
            {chat.title}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="New chat"
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => {
          void createChat(worktreeId)
        }}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
