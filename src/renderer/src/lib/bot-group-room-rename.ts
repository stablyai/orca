import { BOT_NAME_MAX_LENGTH } from '../../../shared/bot-types'
import { findBotGroupRoom } from '../../../shared/bots/bot-group'
import { readBotGroups } from './bot-group-catalog-snapshot'
import { callBotRpc } from './bot-hosts'

/** Renames a room on its host: the original room is named by its group, a thread by its own title.
 *  An empty or unchanged name is no rename: an untitled thread keeps waiting for its first post. */
export async function renameBotGroupRoom(
  roomId: string,
  name: string | null,
  shownName: string
): Promise<void> {
  if (!name || name === shownName) {
    return
  }
  const place = findBotGroupRoom(readBotGroups(), roomId)
  if (!place) {
    return
  }
  const { group, threadId } = place
  await (threadId
    ? callBotRpc(group, 'bots.groups.renameThread', { groupId: group.id, threadId, title: name })
    : callBotRpc(group, 'bots.groups.update', {
        groupId: group.id,
        revision: group.revision,
        name: name.slice(0, BOT_NAME_MAX_LENGTH)
      }))
}
