import type { BotHost } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { CommanderChatRecentResult } from '../../../../shared/rpc-contract/commander-chat'
import { selectedCommanderHost } from './selected-commander-host'

export async function recentCommanderGoal({
  target,
  hostId
}: BotHost): Promise<{ goal: string; progress: string }> {
  const result = CommanderChatRecentResult.parse(
    await callRuntimeRpc<unknown>(target, 'commanderChat.recent')
  )
  return selectedCommanderHost().hostId === hostId ? result : { goal: '', progress: '' }
}
