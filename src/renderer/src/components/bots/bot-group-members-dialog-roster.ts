import { translate } from '@/i18n/i18n'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupMemberRefs } from '../../../../shared/bots/bot-sidebar-entries'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

// The members dialog's roster across computers: which hosts a room here can hold, and how a
// group's saved remote members map to and from the catalog's bots.

/** A room here can hold this computer's bots and paired computers' bots, never an SSH host's. */
export function mixable(hostId: ExecutionHostId): boolean {
  const parsed = parseRoutableExecutionHostId(hostId)
  return parsed?.kind === 'local' || parsed?.kind === 'runtime'
}

/** The catalog's bots, and any remote member of `group` it doesn't list (its computer is offline or
 *  no longer paired), drawn from what the room saved when it joined. */
export function withUnlistedMembers(bots: readonly Bot[], group: BotGroup | undefined): Bot[] {
  const listed = new Set(bots.map(botRefKey))
  const unlisted = (group?.remoteMembers ?? []).flatMap((member): Bot[] => {
    const hostId = toRuntimeExecutionHostId(member.environmentId)
    return listed.has(botRefKey({ hostId, id: member.botId }))
      ? []
      : [
          stampBotHost(hostId, {
            id: member.botId,
            name: member.name,
            hostId: LOCAL_EXECUTION_HOST_ID,
            folder: member.botId,
            folderWorkspaceId: '',
            agent: member.agent,
            avatar: member.avatar,
            ...(member.avatarColor ? { avatarColor: member.avatarColor } : {}),
            ...(member.avatarOutfit ? { avatarOutfit: member.avatarOutfit } : {}),
            paused: false,
            notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
            members: [],
            slack: null,
            linear: null,
            github: null,
            chatSessionId: member.chatSessionId,
            createdAt: 0,
            updatedAt: 0
          })
        ]
  })
  return unlisted.length === 0 ? [...bots] : [...bots, ...unlisted]
}

/** The group's members by host-qualified key, local ones first as saved, then remote ones. */
export function groupMemberKeys(group: BotGroup): string[] {
  return botGroupMemberRefs(group).map(botRefKey)
}

/** The picked bots on paired computers, as the room here saves them. A member whose computer is
 *  offline isn't listed; it stays unless unpicked, so an edit never drops it silently. */
export function remoteRoster(
  order: readonly string[],
  allBots: readonly Bot[],
  group: BotGroup | undefined
) {
  return order.flatMap((key) => {
    const bot = allBots.find((entry) => botRefKey(entry) === key)
    const parsed = parseRoutableExecutionHostId(bot?.hostId)
    if (bot && parsed?.kind === 'runtime') {
      // Questions go to the bot's own Home Chat, so one that never chatted has nowhere to take them.
      if (!bot.chatSessionId) {
        throw new Error(
          translate(
            'bots.groups.remoteNeedsChat',
            'Open a chat with {{name}} once, then add it to the group.',
            { name: bot.name }
          )
        )
      }
      return [
        {
          environmentId: parsed.environmentId,
          botId: bot.id,
          chatSessionId: bot.chatSessionId,
          name: bot.name,
          avatar: bot.avatar,
          ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}),
          ...(bot.avatarOutfit ? { avatarOutfit: bot.avatarOutfit } : {}),
          agent: bot.agent
        }
      ]
    }
    const kept = bot
      ? undefined
      : group?.remoteMembers?.find(
          (member) =>
            botRefKey({ hostId: `runtime:${member.environmentId}`, id: member.botId }) === key
        )
    return kept
      ? [(({ computer: _computer, joinedAfter: _joinedAfter, ...rest }) => rest)(kept)]
      : []
  })
}
