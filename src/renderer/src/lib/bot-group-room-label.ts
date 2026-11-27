import { translate } from '@/i18n/i18n'
import type { BotGroup } from '../../../shared/bots/bot-group'

/** A room's name: a thread's title (first post or owner-given), or the group's name for the original room. */
export function botGroupRoomLabel(
  group: Pick<BotGroup, 'name' | 'threads'>,
  threadId: string | undefined
): string {
  if (!threadId) {
    return group.name
  }
  return (
    group.threads?.find((thread) => thread.id === threadId)?.title ??
    translate('bots.groups.newThreadTab', 'New thread')
  )
}
