// A new chat a teammate started while the owner's computer was away opens as a placeholder tab. Once
// that computer is reachable, its host starts (or finds, if a held message already did) the chat for
// the placeholder's id, and the tab moves to it.
import { useAppStore } from '@/store'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import {
  isSharedBotNewChatId,
  type SharedBotHostView
} from '../../../../../shared/bots/shared-bot-hosts'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { readSharedBotHosts, subscribeSharedBotHosts } from './shared-bot-host-catalog'

/** Moves one placeholder tab to the chat its host started for it: the chat opens through the same
 *  path as any of the agent's chats, and the placeholder closes only once it has. */
export async function swapSharedBotNewChat(
  host: Pick<SharedBotHostView, 'environmentId' | 'botId'>,
  workspaceId: string,
  tab: Pick<Tab, 'id' | 'entityId'>
): Promise<boolean> {
  const { sessionId } = await callRuntimeRpc<{ sessionId: string }>(
    { kind: 'environment', environmentId: host.environmentId },
    'bots.session.start',
    { botId: host.botId, newChatId: tab.entityId }
  )
  const opened = await activateAiVaultStructuredSession({
    structuredSession: { workspaceId, sessionId }
  })
  if (opened) {
    useAppStore.getState().closeUnifiedTab(tab.id)
  }
  return opened
}

/** Follows the shared hosts; each placeholder tab on one that is live moves once. */
export function installSharedBotNewChatSwap(): () => void {
  const swapping = new Set<string>()
  const run = (): void => {
    const tabsByWorkspace = useAppStore.getState().unifiedTabsByWorktree
    for (const host of readSharedBotHosts()) {
      if (host.link !== 'live') {
        continue
      }
      const hostId = toRuntimeExecutionHostId(host.environmentId)
      for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
        for (const tab of tabs) {
          if (
            tab.contentType === 'agent-session' &&
            tab.executionHostId === hostId &&
            isSharedBotNewChatId(tab.entityId) &&
            !swapping.has(tab.id)
          ) {
            swapping.add(tab.id)
            void swapSharedBotNewChat(host, workspaceId, tab)
              .catch((error: unknown) => console.warn('[shared-agents] new chat not opened', error))
              .finally(() => swapping.delete(tab.id))
          }
        }
      }
    }
  }
  run()
  return subscribeSharedBotHosts(run)
}
