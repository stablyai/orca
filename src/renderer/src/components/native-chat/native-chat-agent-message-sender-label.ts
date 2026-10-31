import { agentMessageSenderLabel } from '../../../../shared/agent-session/agent-message-presentation'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  structuredChatTabBySessionId,
  structuredChatWorkspacesBySessionId
} from '@/lib/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs,
  resolveStructuredAgentSessionOwner,
  executionHostIdForStructuredTarget
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { Tab } from '../../../../shared/tab-types'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export function unnamedSenderLabel(): string {
  return translate('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

const qualifiedTabs = new WeakMap<
  AppState['unifiedTabsByWorktree'],
  {
    inputs: unknown[]
    tabs: Map<string, Map<string | null, Tab>>
  }
>()
function qualifiedSenderTab(
  state: AppState,
  sessionId: string,
  host: string | null
): Tab | undefined {
  const source = state.unifiedTabsByWorktree
  const inputs = structuredAgentSessionOwnerInputs(state)
  let cached = qualifiedTabs.get(source)
  if (!cached || inputs.some((value, index) => value !== cached?.inputs[index])) {
    const tabs = new Map<string, Map<string | null, Tab>>()
    for (const bucket of Object.values(source)) {
      for (const tab of bucket) {
        if (tab.contentType !== 'agent-session') {
          continue
        }
        const owner = structuredAgentSessionOwnerForTab(state, tab)
        let byHost = tabs.get(tab.entityId)
        if (!byHost) {
          byHost = new Map()
          tabs.set(tab.entityId, byHost)
        }
        if (!byHost.has(owner)) {
          byHost.set(owner, tab)
        }
      }
    }
    cached = { inputs, tabs }
    qualifiedTabs.set(source, cached)
  }
  return cached.tabs.get(sessionId)?.get(host)
}

export function findAgentMessageSenderChatTab(
  state: AppState,
  sessionId: string,
  executionHostId: string | null
): Tab | undefined {
  const tabsByWorktree = state.unifiedTabsByWorktree
  for (const worktreeId of structuredChatWorkspacesBySessionId(tabsByWorktree, sessionId)) {
    const tab = structuredChatTabBySessionId(tabsByWorktree, worktreeId, sessionId)
    if (tab && structuredAgentSessionOwnerForTab(state, tab) === executionHostId) {
      return tab
    }
    // A workspace bucket can mirror identical session ids from two hosts.
    const qualified = tab && qualifiedSenderTab(state, sessionId, executionHostId)
    if (qualified) {
      return qualified
    }
  }
  return undefined
}

export function agentMessageSenderOwner(
  state: AppState,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget
): string | null {
  return target
    ? executionHostIdForStructuredTarget(target)
    : chatWorktreeId && getKnownExecutionHostIdForWorktree(state, chatWorktreeId)
      ? resolveStructuredAgentSessionOwner(state, chatWorktreeId)
      : null
}

/** Live chat names follow the sender's chat on the receiving chat's host; CLI names stay as recorded. */
export function useAgentMessageSenderLabel(
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget
): string {
  const { address, orcaSessionId } = sender.party
  const local = !address.startsWith('dispatch:')
  const owner = useAppStore((state) => agentMessageSenderOwner(state, chatWorktreeId, target))
  const chatTab = useAppStore((state) =>
    local && owner && orcaSessionId
      ? findAgentMessageSenderChatTab(state, orcaSessionId, owner)
      : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  return agentMessageSenderLabel({
    localChat: Boolean(local && chatTab),
    customLabel: chatTab?.customLabel,
    conversationName,
    snapshotName: sender.name,
    tabLabel: chatTab?.label,
    fallback: unnamedSenderLabel()
  })
}
