import type { BotGroup } from '../../../shared/bots/bot-group'
import { stampBotGroupHost } from './bot-group-catalog-snapshot'
import { callBotRpc, type BotOnHost } from './bot-hosts'

/**
 * A group call whose answer carries the group. The host stores `local` for its own groups, which
 * on a paired server names this computer instead, so the answer is stamped with the host it came
 * from and every later call about the group goes back there.
 */
export async function callBotGroupRpc<TResult extends { group: BotGroup }>(
  host: BotOnHost,
  method: string,
  params: unknown
): Promise<TResult> {
  const result = await callBotRpc<TResult>(host, method, params)
  return { ...result, group: stampBotGroupHost(host.hostId, result.group) }
}
