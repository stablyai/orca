import { useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { SidebarSectionHeader } from '../SidebarSectionHeader'
import WorktreeList from '../worktree-list/listing/WorktreeList'
import { NewChatWorkspaceMenu } from './NewChatWorkspaceMenu'
import type { VirtualizedScrollAnchor } from '@/lib/list-interaction/virtualized-scrolling/useVirtualizedScrollAnchor'

export function ChatWorkspaceSection({
  onWorktreeCardClick
}: {
  onWorktreeCardClick?: () => void
}) {
  const t = useTranslate()
  const repos = useAppStore((state) => state.repos)
  const hasChats = useMemo(() => repos.some((repo) => repo.chatWorkspace), [repos])
  const scrollOffsetRef = useRef(0)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  const collapsed = useAppStore((state) => state.collapsedGroups.has('sidebar:chats'))
  const toggle = useAppStore((state) => state.toggleCollapsedGroup)
  return (
    <section className="flex min-h-0 shrink-0 flex-col" data-chat-workspaces="">
      <SidebarSectionHeader
        title={t('sidebar.chats.title', 'Chats')}
        sectionId="chats"
        actions={<NewChatWorkspaceMenu onBeforeCreate={onWorktreeCardClick} />}
        fold={{
          collapsed,
          disabled: !hasChats,
          onToggle: () => toggle('sidebar:chats'),
          label: collapsed
            ? t('sidebar.chats.expand', 'Expand Chats')
            : t('sidebar.chats.collapse', 'Collapse Chats')
        }}
      />
      {hasChats && !collapsed ? (
        <div className="flex max-h-64 min-h-24 flex-col">
          <WorktreeList
            workspaceSection="chats"
            onWorktreeCardClick={onWorktreeCardClick}
            scrollOffsetRef={scrollOffsetRef}
            scrollAnchorRef={scrollAnchorRef}
          />
        </div>
      ) : null}
    </section>
  )
}
