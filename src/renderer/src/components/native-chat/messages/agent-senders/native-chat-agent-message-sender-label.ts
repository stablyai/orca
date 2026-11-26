import {
  hasAgentSenderPublication,
  selectAgentSenderAssociation
} from '@/runtime/native-chat/agent-senders/agent-sender-associations'
import { useMemo } from 'react'
import {
  useLeasedSenderSelector,
  useStableSenderTarget
} from './native-chat-agent-message-sender-source'
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
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import type { Bot } from '../../../../../../shared/bot-types'

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

type LabelSource = { host: string | null; tab?: Tab; sessionId?: string; worktreeId: string | null }
const NO_ROWS: readonly [] = []

/** The chat a label names its sender by; the same object until its host, tab or session moves. */
function labelSourceSelector(
  party: AgentMessageSender['party'] | undefined,
  chatWorktreeId: string | null,
  target: RuntimeClientTarget | undefined,
  dispatchId: string | undefined
): (state: AppState) => LabelSource {
  const identity = party ? { party, name: null } : undefined
  const { address, orcaSessionId } = party ?? {}
  let previous: LabelSource = { host: null, worktreeId: null }
  return (state) => {
    const owner = agentMessageSenderOwner(state, chatWorktreeId, target)
    const association =
      owner && identity
        ? selectAgentSenderAssociation(state, owner, identity, dispatchId)
        : undefined
    const legacyTab =
      owner &&
      orcaSessionId &&
      address !== undefined &&
      !address.startsWith('dispatch:') &&
      !hasAgentSenderPublication(state, owner)
        ? findAgentMessageSenderChatTab(state, orcaSessionId, owner)
        : undefined
    const sessionId = association?.sessionId ?? legacyTab?.entityId
    const next = {
      host: association?.host ?? owner,
      tab: association?.tab ?? legacyTab,
      sessionId,
      worktreeId: sessionId ? (association?.worktreeId ?? legacyTab?.worktreeId ?? null) : null
    }
    if (
      next.host !== previous.host ||
      next.tab !== previous.tab ||
      next.sessionId !== previous.sessionId ||
      next.worktreeId !== previous.worktreeId
    ) {
      previous = next
    }
    return previous
  }
}

function useAgentMessageSenderChat(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
): LabelSource {
  const { address, orcaSessionId, terminalHandle } = sender?.party ?? {}
  const stableTarget = useStableSenderTarget(target)
  const select = useMemo(
    () =>
      labelSourceSelector(
        address !== undefined
          ? {
              address,
              orcaSessionId: orcaSessionId ?? null,
              terminalHandle: terminalHandle ?? null
            }
          : undefined,
        chatWorktreeId,
        stableTarget,
        dispatchId
      ),
    [address, orcaSessionId, terminalHandle, chatWorktreeId, stableTarget, dispatchId]
  )
  return useLeasedSenderSelector(NO_ROWS, select)
}

/** The bot whose home the sender's chat is in; null for any other sender. */
export function useAgentMessageSenderBot(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
): Bot | null {
  return useBotForWorkspace(
    useAgentMessageSenderChat(sender, chatWorktreeId, target, dispatchId).worktreeId
  )
}

/** Live chat names follow the sender's chat on the receiving chat's host; CLI names stay as recorded. */
export function useAgentMessageSenderLabel(
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
): string {
  const t = useTranslate()
  const chat = useAgentMessageSenderChat(sender, chatWorktreeId, target, dispatchId)
  const bot = useBotForWorkspace(chat.worktreeId)
  const conversationName = useStructuredConversationName(chat.host, chat.sessionId)
  return agentMessageSenderLabel({
    localChat: Boolean(chat.sessionId),
    // A paired server's bot is not in this computer's catalog; its host's saved name says so.
    botName: bot?.name ?? (sender.bot ? sender.name : null),
    customLabel: chat.tab?.customLabel,
    conversationName,
    snapshotName: sender.name,
    tabLabel: chat.tab?.label,
    fallback: unnamedSenderLabel(t)
  })
}
