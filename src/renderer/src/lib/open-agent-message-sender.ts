// Open the sender the card resolved; a host lookup chooses feedback from its own evidence, never the sender's address shape.

import { toast } from 'sonner'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type {
  OrchestrationPartyLocation,
  OrchestrationPartyLocationResult
} from '../../../shared/orchestration-caller-status'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import {
  activateAiVaultStructuredSession,
  structuredSessionOpenFeedback
} from './activate-ai-vault-structured-session'
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import {
  focusTerminal,
  openLocatedAgentMessageSender,
  showLookupFailure,
  type LookupFailure
} from './open-located-agent-message-sender'
import { unnamedSenderLabel } from '@/components/native-chat/native-chat-agent-message-sender-label'
import {
  agentMessageSenderOpens,
  agentMessageSenderReplacedOnHandle,
  agentMessageSenderUnavailableText,
  resolveAgentMessageSenderTarget
} from '@/components/native-chat/native-chat-agent-message-sender-target'
import {
  executionHostIdForStructuredTarget,
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

type Sender = AgentMessageSource['senders'][number]
type Lookup = OrchestrationPartyLocationResult | LookupFailure

const opensInFlight = new Map<string, Promise<void>>()

/** Open what the card's own sender resolution names; an older host, a closed chat or an exited
 *  terminal goes back to the host lookup, and nothing else ever looks a pane up again. */
export function openAgentMessageSender(
  source: AgentMessageSource,
  sender: Sender,
  chatWorktreeId: string,
  target?: RuntimeClientTarget,
  dispatchId?: string,
  name?: string
): Promise<void> {
  const state = useAppStore.getState()
  // Read at click time, so a stale render cannot open what the host has since rejected.
  const resolved = resolveAgentMessageSenderTarget(
    state,
    sender,
    chatWorktreeId,
    target,
    dispatchId
  )
  const label = name ?? sender.name ?? unnamedSenderLabel()
  if (resolved.kind === 'located') {
    return openLocatedAgentMessageSender(resolved.location, label, {
      current: () =>
        resolveAgentMessageSenderTarget(
          useAppStore.getState(),
          sender,
          chatWorktreeId,
          target,
          dispatchId
        ),
      reopen: () => openAgentMessageSender(source, sender, chatWorktreeId, target, dispatchId, name)
    })
  }
  // Only a publishing host's answer can say nothing opens; an older host keeps its own lookup.
  if (
    resolved.kind !== 'none' &&
    resolved.kind !== 'legacy' &&
    !agentMessageSenderOpens(resolved, sender)
  ) {
    toast.info(agentMessageSenderUnavailableText(resolved, label))
    return Promise.resolve()
  }
  const host =
    target ??
    (getKnownExecutionHostIdForWorktree(state, chatWorktreeId)
      ? structuredAgentSessionTargetForHost(
          resolveStructuredAgentSessionOwner(state, chatWorktreeId)
        )
      : null)
  if (!host) {
    showLookupFailure('unreachable')
    return Promise.resolve()
  }
  const key = `${executionHostIdForStructuredTarget(host)}\0${chatWorktreeId}\0${sender.party.address}\0${dispatchId ?? ''}`
  const inFlight = opensInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const opening = openSender(source, sender, host, label)
    .catch((error: unknown) => {
      // Every answer above shows its own words; one that threw showed none.
      console.warn('[agent-message-sender] opening the sender failed', error)
      showLookupFailure('unreachable')
    })
    .finally(() => opensInFlight.delete(key))
  opensInFlight.set(key, opening)
  return opening
}

async function openSender(
  source: AgentMessageSource,
  sender: Sender,
  host: RuntimeClientTarget,
  name: string
): Promise<void> {
  const { party } = sender
  const environmentId = host.kind === 'environment' ? host.environmentId : null
  // Mail identifies senders beyond old terminal handles; tasks carry no mail and resolve coordinators by address.
  const mail = source.orchestration?.message === 'mail-notice' ? source.orchestration.messages : []
  const messageIds = mail
    .filter((message) => message.from === party.address)
    .map((message) => message.messageId)
  const found = await lookUpSender(party, messageIds, host)
  if (typeof found === 'string') {
    showLookupFailure(found)
    return
  }
  const { location } = found
  if (!location) {
    if (found.lost === 'chat') {
      structuredSessionOpenFeedback.gone()
    } else if (found.lost === 'terminal') {
      showAgentPaneUnavailable()
    } else {
      // Not found, and not proven gone: one this host does not run.
      showLookupFailure('unreachable')
    }
    return
  }
  if (location.kind === 'chat') {
    const session = {
      structuredSession: { workspaceId: location.worktreeId, sessionId: location.sessionId }
    }
    await activateAiVaultStructuredSession(session, undefined, host)
    return
  }
  if (location.kind !== 'terminal') {
    // A kind a newer host answers with.
    showLookupFailure('update')
    return
  }
  // The host's lookup may find whatever shell now holds the old pane; a known other agent isn't it.
  if (
    agentMessageSenderReplacedOnHandle(
      useAppStore.getState(),
      sender,
      executionHostIdForStructuredTarget(host),
      location.handle
    )
  ) {
    toast.info(agentMessageSenderUnavailableText({ kind: 'replaced' }, name))
    return
  }
  await focusTerminal(location.handle, environmentId)
}

async function lookUpSender(
  party: Sender['party'],
  messageIds: readonly string[],
  host: RuntimeClientTarget
): Promise<Lookup> {
  try {
    return await callRuntimeRpc<OrchestrationPartyLocationResult>(
      host,
      'orchestration.partyLocation',
      { address: party.address, ...(messageIds.length > 0 ? { messageIds } : {}) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return lookUpOnOlderHost(party, host)
    }
    return isRuntimeCompatBlockError(error) ? 'update' : 'unreachable'
  }
}

/** Older hosts allow root-ID chats and terminal-handle opens; other identities require updating that host. */
function lookUpOnOlderHost(party: Sender['party'], host: RuntimeClientTarget): Lookup {
  const sessionId = party.orcaSessionId
  if (sessionId) {
    const state = useAppStore.getState()
    const tabsByWorktree = state.unifiedTabsByWorktree
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      if (
        tabs.some(
          (tab) =>
            tab.contentType === 'agent-session' &&
            tab.entityId === sessionId &&
            structuredAgentSessionOwnerForTab(state, tab) ===
              executionHostIdForStructuredTarget(host)
        )
      ) {
        return located({ kind: 'chat', sessionId, worktreeId })
      }
    }
    return 'older-host'
  }
  const handle = party.terminalHandle
  return handle && !handle.startsWith('dispatch:') && !handle.startsWith('run:')
    ? located({ kind: 'terminal', handle })
    : 'older-host'
}

function located(location: OrchestrationPartyLocation): OrchestrationPartyLocationResult {
  return { location }
}
