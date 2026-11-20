import { useState } from 'react'
import { Archive, Loader2 } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { workspaceChatKey, type WorkspaceChat } from '@/lib/agent-session/history/workspace-chats'

export function WorkspaceChatList({
  chats,
  onOpen,
  onArchive
}: {
  chats: readonly WorkspaceChat[]
  onOpen: (chat: WorkspaceChat) => Promise<void>
  onArchive: (chat: WorkspaceChat) => void
}) {
  const t = useTranslate()
  const [opening, setOpening] = useState<string | null>(null)
  if (!chats.length) {
    return null
  }
  const stopBubble = (event: React.SyntheticEvent) => event.stopPropagation()
  const archiveLabel = t('sidebar.workspaceChats.archive', 'Archive chat')
  return (
    <div
      className="mt-1 flex min-w-0 flex-col gap-0.5"
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onPointerDown={stopBubble}
      onMouseDown={stopBubble}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
        }
      }}
    >
      <span className="px-2 text-2xs font-medium text-muted-foreground">
        {t('sidebar.workspaceChats.saved', 'Saved chats')}
      </span>
      {chats.map((chat) => {
        const key = workspaceChatKey(chat)
        return (
          <div
            key={key}
            className="group/workspace-chat flex min-w-0 items-center rounded-sm hover:bg-sidebar-accent"
          >
            <button
              type="button"
              className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 text-left text-2xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              disabled={opening === key}
              onClick={() => {
                setOpening(key)
                void onOpen(chat).finally(() => setOpening(null))
              }}
              title={chat.title}
            >
              {opening === key ? (
                <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
              ) : (
                <AgentTypeIcon agentType={chat.agent} size={13} />
              )}
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label={`${archiveLabel}: ${chat.title}`}
                  disabled={opening === key}
                  onClick={() => onArchive(chat)}
                >
                  <Archive className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {archiveLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}
