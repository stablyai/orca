import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { BotItem } from '../../../shared/bots/bot-items'

/** What a bot item link may do with the host's read of its item: another bot's item never opens. */
export async function botItemLinkCheck(
  botId: string,
  read: () => Promise<{ item: Pick<BotItem, 'owner'> }>
): Promise<'open' | 'missing' | 'unreadable'> {
  try {
    const { item } = await read()
    return item.owner.botId === botId ? 'open' : 'missing'
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'not_found') {
      return 'missing'
    }
    console.warn('[bots] reading a linked item failed', error)
    return 'unreadable'
  }
}
