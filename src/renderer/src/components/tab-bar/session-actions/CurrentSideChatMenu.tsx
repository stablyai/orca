import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useHostStructuredAgentsVersion } from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { readHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { agentChatPermissionModes } from '../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { openCurrentSideChat } from '../../native-chat/messages/actions/current-side-chat-launch'

export function CurrentSideChatMenu({ worktreeId, tabId }: { worktreeId: string; tabId: string }) {
  const t = useTranslate()
  const tab = useAppStore((state) =>
    state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  )
  const statuses = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  useHostStructuredAgentsVersion()
  const host = tab ? structuredAgentSessionOwnerForTab(useAppStore.getState(), tab) : null
  const target = structuredAgentSessionTargetForHost(host)
  const support = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY
  )
  const agent = tab?.agentSessionAgent
  const registered = host
    ? readHostStructuredAgents(host, statuses)?.find((row) => row.agent === agent)
    : undefined
  if (support !== 'supported' || !registered?.capabilities.currentFork) {
    return null
  }
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        {t('components.native-chat.currentSideChat.open', 'New side chat')}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem onSelect={() => void openCurrentSideChat(worktreeId, tabId, 'inherit')}>
          {t('components.native-chat.currentSideChat.inherit', 'Same permissions as this chat')}
        </ContextMenuItem>
        {agent && agentChatPermissionModes(agent)?.modes.includes('read-only') ? (
          <ContextMenuItem
            onSelect={() => void openCurrentSideChat(worktreeId, tabId, 'read-only')}
          >
            {t('components.native-chat.currentSideChat.readOnly', 'Read-only')}
          </ContextMenuItem>
        ) : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
