import React, { useState } from 'react'
import { callBotRpc } from '@/lib/bot-hosts'
import { Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import { useNow } from '@/lib/window-activity/use-now'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useTranslate } from '@/i18n/use-translate'
import { openBotGroup } from '@/lib/bot-group-catalog'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotAvatar } from './BotAvatar'
import { botRowLineAge, BotHoverLatestLine, BotRowLineView } from './BotRowActivityLine'
import type { BotRowLine } from './bot-row-activity-line'
import { botGroupStatus } from '../../../../shared/bots/bot-group-status'
import { botGroupRowLine } from '../../../../shared/bots/bot-sidebar-entries'
import { BotSidebarRow } from './BotSidebarRow'
import { botErrorMessage } from './bot-presentation'
import { botGroupFaces } from '../../../../shared/bots/bot-group-face-layout'
import { BotGroupFaces } from './BotGroupFaces'

const createBotGroupStatusSelector = () =>
  createAgentStatusEpochSelector((state: AppState, group: Pick<BotGroup, 'members' | 'threads'>) =>
    botGroupStatus(group, state.agentStatusByPaneKey, Date.now())
  )

/** A group in the Bots section: its members' faces, then the room's newest post. */
export function BotGroupRow({
  group,
  home,
  members,
  isActive,
  onOpen,
  onManageMembers,
  onDelete,
  dragHandle = false
}: {
  group: BotGroup
  home: FolderWorkspace
  /** Its members' bots, as loaded. */
  members: readonly Bot[]
  isActive: boolean
  onOpen: () => void
  onManageMembers: () => void
  onDelete: () => void
  dragHandle?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const workspaceId = folderWorkspaceKey(home.id)
  const now = useNow(60_000)
  // Recompute only when agentStatusEpoch or group changes (turn/state updates and freshness ticks).
  const [selectGroupStatus] = useState(createBotGroupStatusSelector)
  const status = useAppStore((state) => selectGroupStatus(state, group))
  const line: BotRowLine = {
    kind: 'activity',
    place: null,
    ...botGroupRowLine(group, members, t('bots.groups.you', 'You'))
  }
  return (
    <BotSidebarRow
      avatar={
        <BotGroupFaces
          faces={botGroupFaces(members, (bot) => bot.id)}
          className="size-8"
          slot={32}
        />
      }
      name={group.name}
      workspaceId={workspaceId}
      hostId={LOCAL_EXECUTION_HOST_ID}
      status={status}
      isUnread={home.isUnread}
      isActive={isActive}
      dragHandle={dragHandle}
      onOpen={() => {
        void openBotGroup(group)
          .then(onOpen)
          .catch((error: unknown) => toast.error(String(error)))
      }}
      onRename={async (name) => {
        try {
          await callBotRpc(group, 'bots.groups.update', {
            groupId: group.id,
            revision: group.revision,
            name
          })
        } catch (error) {
          throw new Error(botErrorMessage(error))
        }
      }}
      age={botRowLineAge(line, now)}
      line={<BotRowLineView line={line} unread={home.isUnread} now={now} />}
      hoverDetails={() => (
        <BotGroupHoverDetails
          group={group}
          members={members}
          latest={<BotHoverLatestLine line={line} now={now} />}
        />
      )}
      menuItems={
        <ContextMenuItem onSelect={onManageMembers}>
          <Users className="size-3.5" />
          {t('bots.groups.manageMembersMenu', 'Manage members…')}
        </ContextMenuItem>
      }
      menuFooter={
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-3.5" />
            {t('bots.groups.deleteGroupMenu', 'Delete group…')}
          </ContextMenuItem>
        </>
      }
    />
  )
}

function BotGroupHoverDetails({
  group,
  members,
  latest
}: {
  group: BotGroup
  members: readonly Bot[]
  /** The row's second line, whole. */
  latest: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="break-words text-[13px] font-semibold leading-snug text-foreground">
        {group.name}
      </div>
      <div className="flex flex-col gap-1.5">
        {members.map((bot) => (
          <div key={bot.id} className="flex items-center gap-2 text-xs text-foreground">
            <BotAvatar bot={bot} className="size-5 rounded text-2xs" />
            <span className="min-w-0 truncate">{bot.name}</span>
          </div>
        ))}
      </div>
      {latest}
    </div>
  )
}
