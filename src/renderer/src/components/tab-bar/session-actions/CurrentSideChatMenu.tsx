import { GitFork } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
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
import { openCurrentSideChat } from '../../native-chat/messages/actions/current-side-chat-launch'

export function CurrentSideChatMenu({ worktreeId, tabId }: { worktreeId: string; tabId: string }) {
  const t = useTranslate()
  const tab = useAppStore((state) =>
    state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  )
  useHostStructuredAgentsVersion()
  const host = useAppStore((state) => (tab ? structuredAgentSessionOwnerForTab(state, tab) : null))
  const target = structuredAgentSessionTargetForHost(host)
  const support = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY
  )
  const agent = tab?.agentSessionAgent
  const registered = useAppStore((state) =>
    host
      ? readHostStructuredAgents(host, state.runtimeStatusByEnvironmentId)?.find(
          (row) => row.agent === agent
        )
      : undefined
  )
  if (support !== 'supported' || !registered?.capabilities.currentFork) {
    return null
  }
  return (
    <ContextMenuItem onSelect={() => void openCurrentSideChat(worktreeId, tabId)}>
      <GitFork className="size-3.5 shrink-0" />
      {t('components.native-chat.currentSideChat.open', 'New side chat')}
    </ContextMenuItem>
  )
}
