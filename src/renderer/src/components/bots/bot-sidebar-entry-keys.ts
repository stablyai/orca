import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import {
  getBotSidebarEntries,
  type BotSidebarEntry
} from '../../../../shared/bots/bot-sidebar-entries'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

/** A row's key across hosts: ids are random per host, so the same id on two hosts is two rows. */
export function botSidebarEntryKey(owner: Pick<Bot | BotGroup, 'hostId' | 'id'>): string {
  return `${owner.hostId}/${owner.id}`
}

/** The Bots section's entries with `id` keyed by host and id, for ordering, drag and Cmd+J. */
export function getHostKeyedBotSidebarEntries(
  bots: readonly Bot[],
  groups: readonly BotGroup[],
  workspaces: readonly FolderWorkspace[]
): BotSidebarEntry<Bot, BotGroup, FolderWorkspace>[] {
  return getBotSidebarEntries(bots, groups, workspaces).map((entry) => ({
    ...entry,
    id: botSidebarEntryKey(entry.kind === 'bot' ? entry.bot : entry.group)
  }))
}
