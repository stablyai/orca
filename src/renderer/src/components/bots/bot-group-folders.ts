// A bot group in the Bots section is a folder for its member bots: they list under its row, fold
// with it, and reorder only among themselves. Membership still changes only in the group's dialog.
import {
  getProjectGroupHeaderDragBucketKey,
  ROOT_PROJECT_GROUP_HEADER_BUCKET,
  type ProjectGroupHeaderDragItem
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupMemberRefs } from '../../../../shared/bots/bot-sidebar-entries'
import { getBotGroupFoldKey } from '../../../../shared/sidebar-list/sections/group-keys'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'

type GroupOfMembers = Pick<BotGroup, 'hostId' | 'id' | 'members' | 'remoteMembers'>
type FolderEntry =
  | { kind: 'bot'; id: string }
  | { kind: 'group'; id: string; group: GroupOfMembers }

/** One top-level row of the Bots section: an ungrouped bot, or a group with the bots in it. */
export type BotSidebarFolder<E extends FolderEntry> = {
  id: string
  entry: E
  /** A group's listed members in the section's order; empty for a bot. */
  members: Extract<E, { kind: 'bot' }>[]
  folded: boolean
  /** Rows listed inside this one, so a reveal or a pinned row finds the folder holding them. */
  nestedIds: string[]
}

/** The group's members by sidebar key (`hostId/id`). */
export function botGroupMemberEntryKeys(group: GroupOfMembers): string[] {
  return botGroupMemberRefs(group).map(botSidebarEntryKey)
}

/**
 * The section's entries, already in their sort order, as folders: a bot in a group lists under it
 * (under each group it is in) and not on its own; groups and ungrouped bots keep their order.
 */
export function nestBotSidebarEntries<E extends FolderEntry>(
  entries: readonly E[],
  collapsedGroups: ReadonlySet<string>
): BotSidebarFolder<E>[] {
  const bots = entries.filter((entry): entry is Extract<E, { kind: 'bot' }> => entry.kind === 'bot')
  const membersOf = new Map<string, Extract<E, { kind: 'bot' }>[]>()
  const grouped = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'group') {
      continue
    }
    const keys = new Set(botGroupMemberEntryKeys(entry.group))
    const members = bots.filter((bot) => keys.has(bot.id))
    membersOf.set(entry.id, members)
    members.forEach((bot) => grouped.add(bot.id))
  }
  return entries.flatMap((entry) => {
    if (entry.kind === 'bot') {
      return grouped.has(entry.id)
        ? []
        : [{ id: entry.id, entry, members: [], folded: false, nestedIds: [] }]
    }
    const members = membersOf.get(entry.id) ?? []
    const folded = members.length > 0 && collapsedGroups.has(getBotGroupFoldKey(entry.id))
    return [
      {
        id: entry.id,
        entry,
        members,
        folded,
        nestedIds: folded ? [] : members.map((bot) => bot.id)
      }
    ]
  })
}

/** A listed member's drag id: one bot can list under two groups, and each copy drags on its own. */
export function botGroupMemberDragId(folderId: string, botId: string): string {
  return `${folderId}>${botId}`
}

export type BotSidebarDragItem<E> = ProjectGroupHeaderDragItem & {
  entry: E
  /** The top-level row this one is or lists in. */
  folderId: string
  bucket: string
  /** Its place among the rows it can trade places with. */
  index: number
}

/**
 * What Manual sort can drag: groups and ungrouped bots among themselves at the top, and an unfolded
 * group's members among themselves. The drag only measures and drops within the dragged row's
 * bucket, so a member let go outside its group's rows stays where it was.
 */
export function botSidebarFolderDrag<E extends FolderEntry>(
  folders: readonly BotSidebarFolder<E>[],
  sidebarOrderOf: (entry: E) => number | undefined
): {
  idsByBucket: Map<string, string[]>
  items: Map<string, BotSidebarDragItem<E>>
} {
  const idsByBucket = new Map<string, string[]>([
    [ROOT_PROJECT_GROUP_HEADER_BUCKET, folders.map(({ id }) => id)]
  ])
  const items = new Map<string, BotSidebarDragItem<E>>()
  // An entry never placed takes no order, so the first drop writes one for every row it moves among.
  const tabOrder = (entry: E): number => sidebarOrderOf(entry) ?? -1
  folders.forEach((folder, index) => {
    items.set(folder.id, {
      entry: folder.entry,
      folderId: folder.id,
      bucket: ROOT_PROJECT_GROUP_HEADER_BUCKET,
      index,
      parentGroupId: null,
      tabOrder: tabOrder(folder.entry)
    })
    if (folder.folded || folder.members.length === 0) {
      return
    }
    const bucket = getProjectGroupHeaderDragBucketKey({ parentGroupId: folder.id })
    const ids = folder.members.map((member) => botGroupMemberDragId(folder.id, member.id))
    idsByBucket.set(bucket, ids)
    folder.members.forEach((member, memberIndex) => {
      items.set(ids[memberIndex]!, {
        entry: member,
        folderId: folder.id,
        bucket,
        index: memberIndex,
        parentGroupId: folder.id,
        tabOrder: tabOrder(member)
      })
    })
  })
  return { idsByBucket, items }
}

/**
 * The group fold a reveal of `entryKey` opens: none when the bot is in no group or an unfolded group
 * already lists it; else the first group that holds it.
 */
export function botGroupFoldToOpen(
  entryKey: string,
  groups: readonly GroupOfMembers[],
  collapsedGroups: ReadonlySet<string>
): string | null {
  const folds = groups
    .filter((group) => botGroupMemberEntryKeys(group).includes(entryKey))
    .map((group) => getBotGroupFoldKey(botSidebarEntryKey(group)))
  return folds.length === 0 || folds.some((key) => !collapsedGroups.has(key)) ? null : folds[0]!
}
