import {
  hasAgentSenderPublication,
  selectAgentSenderAssociation
} from '@/runtime/native-chat/agent-senders/agent-sender-associations'
import { useMemo } from 'react'
import { agentMessageSenderLabel } from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import {
  structuredChatTabBySessionId,
  structuredChatWorkspacesBySessionId
} from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import { useStructuredConversationName } from '@/runtime/native-chat/naming/structured-conversation-name'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs,
  resolveStructuredAgentSessionOwner,
  executionHostIdForStructuredTarget
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentMessageSender } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  useLeasedSenderSelector,
  useStableSenderTarget
} from './native-chat-agent-message-sender-source'

export function unnamedSenderLabel(t: Translate = translate): string {
  return t('components.native-chat.agentMessage.unnamedSender', 'an agent')
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

type LabelSource = { host: string | null; tab?: Tab; sessionId?: string }
const NO_ROWS: readonly [] = []

/** The chat a label names its sender by; the same object until its host, tab or session moves. */
function labelSourceSelector(
  party: AgentMessageSender['party'],
  chatWorktreeId: string | null,
  target: RuntimeClientTarget | undefined,
  dispatchId: string | undefined
): (state: AppState) => LabelSource {
  const identity: AgentMessageSender = { party, name: null }
  const { address, orcaSessionId } = party
  let previous: LabelSource = { host: null }
  return (state) => {
    const owner = agentMessageSenderOwner(state, chatWorktreeId, target)
    const association = owner
      ? selectAgentSenderAssociation(state, owner, identity, dispatchId)
      : undefined
    const legacyTab =
      owner &&
      orcaSessionId &&
      !address.startsWith('dispatch:') &&
      !hasAgentSenderPublication(state, owner)
        ? findAgentMessageSenderChatTab(state, orcaSessionId, owner)
        : undefined
    const next = {
      host: association?.host ?? owner,
      tab: association?.tab ?? legacyTab,
      sessionId: association?.sessionId ?? legacyTab?.entityId
    }
    if (
      next.host !== previous.host ||
      next.tab !== previous.tab ||
      next.sessionId !== previous.sessionId
    ) {
      previous = next
    }
    return previous
  }
}

/** Live chat names follow the sender's chat on the receiving chat's host; CLI names stay as recorded. */
export function useAgentMessageSenderLabel(
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
): string {
  const t = useTranslate()
  const { address, orcaSessionId, terminalHandle } = sender.party
  const stableTarget = useStableSenderTarget(target)
  const select = useMemo(
    () =>
      labelSourceSelector(
        { address, orcaSessionId, terminalHandle },
        chatWorktreeId,
        stableTarget,
        dispatchId
      ),
    [address, orcaSessionId, terminalHandle, chatWorktreeId, stableTarget, dispatchId]
  )
  const { host, tab, sessionId } = useLeasedSenderSelector(NO_ROWS, select)
  const conversationName = useStructuredConversationName(host, sessionId)
  return agentMessageSenderLabel({
    localChat: Boolean(sessionId),
    customLabel: tab?.customLabel,
    conversationName,
    snapshotName: sender.name,
    tabLabel: tab?.label,
    fallback: unnamedSenderLabel(t)
  })
}
