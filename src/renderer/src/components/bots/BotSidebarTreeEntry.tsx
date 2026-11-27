import type { CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { BotSidebarEntry as Entry } from '../../../../shared/bots/bot-sidebar-entries'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { BotFolderDialogState } from './BotFolderDialogs'
import { BotAvatar } from './BotAvatar'
import { BotGroupRow } from './BotGroupRow'
import { openBotFromSidebar } from './BotRow'
import { BotSidebarDragFrame, BotSidebarEntry, type BotSidebarEntryDrag } from './BotSidebarEntry'
import { BotSidebarFolderRow } from './BotSidebarFolderRow'
import type { BotSidebarTreeRow } from './bot-sidebar-folder-rows'

type TreeRow = BotSidebarTreeRow<Entry<Bot, BotGroup, FolderWorkspace>>

export function BotSidebarTreeEntry({
  row,
  drag,
  onOpen,
  onFolderAction,
  onToggleFolder,
  onToggleGroup,
  onCreateSubgroup,
  onManageMembers,
  onMoveGroup,
  onDeleteGroup,
  membersByGroup,
  activeGroupId,
  activeWorkspaceId,
  pendingRenameKey,
  onRenameConsumed,
  hasFolders
}: {
  row: TreeRow
  drag?: BotSidebarEntryDrag
  onOpen: () => void
  onFolderAction: (state: BotFolderDialogState) => void
  onToggleFolder: (id: string) => void
  onToggleGroup: (id: string) => void
  onCreateSubgroup?: (id: string) => void
  onManageMembers: (group: BotGroup) => void
  onMoveGroup: (group: BotGroup) => void
  onDeleteGroup: (group: BotGroup) => void
  membersByGroup: ReadonlyMap<string, readonly Bot[]>
  activeGroupId: string | null
  activeWorkspaceId: string | null
  pendingRenameKey: string | null
  onRenameConsumed: (id: string) => void
  hasFolders: boolean
}): React.JSX.Element | null {
  if (row.kind === 'folder') {
    return (
      <BotSidebarFolderRow
        folder={row.folder}
        depth={row.depth}
        expanded={row.expanded}
        hasChildren={row.hasChildren}
        onToggle={() => onToggleFolder(row.folder.id)}
        onAction={onFolderAction}
      />
    )
  }
  const { entry } = row
  const style: CSSProperties | undefined = row.depth
    ? { paddingInlineStart: `min(${row.depth * 12}px, 40%)` }
    : undefined

  if (row.kind === 'member') {
    if (entry.kind !== 'bot') {
      return null
    }
    const { bot } = entry
    return (
      <div style={style}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full min-w-0 justify-start"
          onClick={() => openBotFromSidebar(bot, onOpen)}
          title={bot.name}
        >
          <BotAvatar bot={bot} className="size-5 shrink-0 rounded text-2xs" />
          <span className="truncate">{bot.name}</span>
        </Button>
      </div>
    )
  }
  if (entry.kind === 'group') {
    const { group } = entry
    return (
      <div style={style}>
        <BotSidebarDragFrame id={entry.id} drag={drag}>
          <BotGroupRow
            group={group}
            home={entry.home}
            members={membersByGroup.get(entry.id) ?? []}
            isActive={activeGroupId === entry.id}
            onOpen={onOpen}
            onManageMembers={() => onManageMembers(group)}
            onMove={() => onMoveGroup(group)}
            onCreateChild={onCreateSubgroup && (() => onCreateSubgroup(entry.id))}
            expanded={row.expanded}
            onToggle={() => onToggleGroup(entry.id)}
            onDelete={() => onDeleteGroup(group)}
            dragHandle={drag !== undefined}
          />
        </BotSidebarDragFrame>
      </div>
    )
  }
  return (
    <div style={style}>
      <BotSidebarEntry
        bot={entry.bot}
        home={entry.home}
        isActive={activeWorkspaceId === folderWorkspaceKey(entry.home.id)}
        onOpen={onOpen}
        drag={drag}
        beginRename={pendingRenameKey === entry.id}
        onBeginRenameConsumed={() => onRenameConsumed(entry.id)}
        onMoveToFolder={
          hasFolders
            ? () => onFolderAction({ type: 'moveBot', entryKey: entry.id, name: entry.bot.name })
            : undefined
        }
      />
    </div>
  )
}
