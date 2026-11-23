import { Network } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useTranslation } from 'react-i18next'

export default function ConversationKnowledgeSidebarEntry(): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const open = useAppStore((s) => s.conversationKnowledgeDrawerOpen)
  const setOpen = useAppStore((s) => s.setConversationKnowledgeDrawerOpen)
  return (
    <button
      type="button"
      aria-current={open ? 'page' : undefined}
      onClick={() => setOpen(!open)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        open
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Network className="size-4 shrink-0 text-worktree-sidebar-foreground/30" strokeWidth={1.75} />
      <span className="flex-1">{t('conversationKnowledge.name', 'Conversation Knowledge')}</span>
    </button>
  )
}
