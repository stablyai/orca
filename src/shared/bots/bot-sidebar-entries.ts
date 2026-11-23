import type { BotGroup } from './bot-group-schema'
import type { ExecutionHostId } from '../execution-host/execution-host'
import { getBotHomes, type BotHomeOwner } from './bot-homes'

type BotHomeWorkspace = Parameters<typeof getBotHomes>[1][number]

/** One row of the Bots section, a bot's or a group's, with its loaded home. */
export type BotSidebarEntry<B, G, W> =
  | { kind: 'bot'; id: string; bot: B; home: W }
  | { kind: 'group'; id: string; group: G; home: W }

/** The Bots section's one list: bots and groups mixed in one saved order, as desktop and phone draw it. */
export function getBotSidebarEntries<
  B extends BotHomeOwner & { id: string },
  G extends BotHomeOwner & { id: string },
  W extends BotHomeWorkspace
>(bots: readonly B[], groups: readonly G[], workspaces: readonly W[]): BotSidebarEntry<B, G, W>[] {
  const owners = [
    ...bots.map((bot) => ({ ...bot, entry: { kind: 'bot' as const, bot } })),
    ...groups.map((group) => ({ ...group, entry: { kind: 'group' as const, group } }))
  ]
  return getBotHomes(owners, workspaces).map(({ bot: { entry }, home }) =>
    entry.kind === 'bot'
      ? { kind: 'bot', id: entry.bot.id, bot: entry.bot, home }
      : { kind: 'group', id: entry.group.id, group: entry.group, home }
  )
}

/** A group's members' bots, as loaded, in the room's member order. */
export function botGroupMemberBots<B extends { id: string }>(
  group: Pick<BotGroup, 'members'>,
  bots: readonly B[] | ReadonlyMap<string, B>
): B[] {
  return group.members.flatMap(
    (member) =>
      ('get' in bots ? bots.get(member.botId) : bots.find((bot) => bot.id === member.botId)) ?? []
  )
}

/** A group's member bots by host: its own computer's as saved, then those on paired computers. */
export function botGroupMemberRefs(
  group: Pick<BotGroup, 'hostId' | 'members' | 'remoteMembers'>
): { hostId: ExecutionHostId; id: string }[] {
  return [
    ...group.members.map((member) => ({ hostId: group.hostId, id: member.botId })),
    ...(group.remoteMembers ?? []).map((member) => ({
      hostId: `runtime:${member.environmentId}` as const,
      id: member.botId
    }))
  ]
}

/** A group row's second line: the room's newest post, else who is in it, as a new bot's row says hello. */
export function botGroupRowLine(
  group: Pick<BotGroup, 'latest'>,
  members: readonly { name: string }[],
  ownerName: string
): { text: string; at: number | null } {
  return group.latest
    ? { text: `${group.latest.authorName ?? ownerName}: ${group.latest.text}`, at: group.latest.at }
    : { text: members.map((bot) => bot.name).join(', '), at: null }
}
