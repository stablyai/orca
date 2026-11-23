import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { BotPreviewSignal } from '../../../../shared/bots/bot-collapsed-preview'
import { getBotGroupFoldKey } from '../../../../shared/sidebar-list/sections/group-keys'
import { botGroupMemberRefs } from '../../../../shared/bots/bot-sidebar-entries'
import type { HostKeyedBotSidebarEntry } from './bot-sidebar-entry-keys'
import {
  botGroupMemberDragId,
  nestBotSidebarEntries,
  type BotSidebarFolder
} from './bot-group-folders'
import { BotSidebarDragFrame, type BotSidebarEntryDrag } from './BotSidebarEntry'
import { BotGroupRow, type BotGroupRowFold } from './BotGroupRow'

type Entry = HostKeyedBotSidebarEntry
type BotEntry = Extract<Entry, { kind: 'bot' }>

// Member rows sit one step in from their group's, as a bot's own lines sit in from it.
const BOT_GROUP_MEMBER_INDENT = 12

/** The section's entries as folders, with each group's saved fold. */
export function useBotGroupFolders(entries: readonly Entry[]): BotSidebarFolder<Entry>[] {
  // Joined keys keep the selector's result stable across other sections' folds.
  const foldedKeys = useAppStore((s) =>
    entries
      .flatMap((entry) =>
        entry.kind === 'group' && s.collapsedGroups.has(getBotGroupFoldKey(entry.id))
          ? [getBotGroupFoldKey(entry.id)]
          : []
      )
      .join('\n')
  )
  return useMemo(
    () => nestBotSidebarEntries(entries, new Set(foldedKeys.split('\n'))),
    [entries, foldedKeys]
  )
}

/** A group's row with its member bots listed under it while it is unfolded. */
export function BotGroupFolder({
  folder,
  group,
  bots,
  isActive,
  signalByBot,
  dragOf,
  renderBot,
  onOpen,
  onManageMembers,
  onDelete
}: {
  folder: BotSidebarFolder<Entry>
  group: Extract<Entry, { kind: 'group' }>
  bots: readonly Bot[]
  isActive: boolean
  /** Each listed bot's strongest signal, as the folded Bots header reads it. */
  signalByBot: ReadonlyMap<string, BotPreviewSignal>
  dragOf: (id: string) => BotSidebarEntryDrag | undefined
  renderBot: (entry: BotEntry, dragId: string) => React.ReactNode
  onOpen: () => void
  onManageMembers: () => void
  onDelete: () => void
}): React.JSX.Element {
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  // By host, so the header's faces and roster match the rows listed under it, paired computers' too.
  const memberBots = useMemo(
    () =>
      botGroupMemberRefs(group.group).flatMap(
        (ref) => bots.find((bot) => bot.hostId === ref.hostId && bot.id === ref.id) ?? []
      ),
    [group.group, bots]
  )
  const drag = dragOf(folder.id)
  const fold: BotGroupRowFold | null =
    folder.members.length > 0
      ? {
          folded: folder.folded,
          membersLive: membersLive(folder.members, signalByBot),
          onToggle: () => toggleCollapsedGroup(getBotGroupFoldKey(folder.id))
        }
      : null
  return (
    <BotSidebarDragFrame id={folder.id} drag={drag}>
      <BotGroupRow
        group={group.group}
        home={group.home}
        members={memberBots}
        isActive={isActive}
        onOpen={onOpen}
        onManageMembers={onManageMembers}
        onDelete={onDelete}
        dragHandle={drag !== undefined}
        fold={fold}
      />
      {folder.folded || folder.members.length === 0 ? null : (
        <div
          role="group"
          aria-label={group.group.name}
          className="flex flex-col"
          style={{ marginLeft: BOT_GROUP_MEMBER_INDENT }}
        >
          {folder.members.map((member) => (
            <React.Fragment key={member.id}>
              {renderBot(member, botGroupMemberDragId(folder.id, member.id))}
            </React.Fragment>
          ))}
        </div>
      )}
    </BotSidebarDragFrame>
  )
}

/** What a folded group shows of its members: one asking for you, else one working. */
function membersLive(
  members: readonly { id: string }[],
  signalByBot: ReadonlyMap<string, BotPreviewSignal>
): BotGroupRowFold['membersLive'] {
  const signals = members.map((member) => signalByBot.get(member.id))
  return signals.includes('attention')
    ? 'permission'
    : signals.includes('working')
      ? 'working'
      : null
}
