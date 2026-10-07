// Opening the agent a chat message is from: its chat through the open-chat flow, or its terminal
// through the terminal-handle link's path. Feedback is chosen by what the host found, never by how
// the sender was addressed, and uses words that already exist.

import { toast } from 'sonner'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import type {
  OrchestrationPartyLocation,
  OrchestrationPartyLocationResult
} from '../../../shared/orchestration-caller-status'
import { useAppStore } from '@/store'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  focusRendererTerminalHandle,
  focusRuntimeTerminalHandle
} from '@/components/terminal-pane/terminal-handle-links'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import {
  activateAiVaultStructuredSession,
  structuredSessionOpenFeedback
} from './activate-ai-vault-structured-session'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

type Sender = AgentMessageSource['senders'][number]
/** `older-host`: the chat's host predates the lookup. `update`: one side is too old, either one.
 *  `unreachable`: no answer at all. */
type LookupFailure = 'older-host' | 'update' | 'unreachable'
type Lookup = OrchestrationPartyLocationResult | LookupFailure

/** The answers that prove the terminal is gone; anything else proves nothing about it. */
const TERMINAL_GONE_CODES = new Set([
  'terminal_exited',
  'terminal_gone',
  'terminal_handle_stale',
  'terminal_not_found'
])

const opensInFlight = new Map<string, Promise<void>>()

/** `chatWorktreeId`: the chat showing the message. The sender lives on that chat's host, so every
 *  call goes to that host. */
export function openAgentMessageSender(
  source: AgentMessageSource,
  sender: Sender,
  chatWorktreeId: string
): Promise<void> {
  const key = `${chatWorktreeId}\0${sender.party.address}`
  const inFlight = opensInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const opening = openSender(source, sender, chatWorktreeId)
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
  { party }: Sender,
  chatWorktreeId: string
): Promise<void> {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), chatWorktreeId)
  // The mail it carried from this sender, whose pane outlives a handle from an earlier run. A task
  // carries no mail, so its coordinator is found by address alone.
  const mail = source.orchestration?.message === 'mail-notice' ? source.orchestration.messages : []
  const messageIds = mail
    .filter((message) => message.from === party.address)
    .map((message) => message.messageId)
  const found = await lookUpSender(
    party,
    messageIds,
    getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })
  )
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
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: location.worktreeId, sessionId: location.sessionId }
    })
    return
  }
  if (location.kind !== 'terminal') {
    // A kind a newer host answers with.
    showLookupFailure('update')
    return
  }
  await focusTerminal(location.handle, environmentId)
}

async function focusTerminal(handle: string, environmentId: string | null): Promise<void> {
  if (focusRendererTerminalHandle(handle, environmentId)) {
    return
  }
  try {
    await focusRuntimeTerminalHandle(handle, environmentId)
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && TERMINAL_GONE_CODES.has(error.code)) {
      showAgentPaneUnavailable()
    } else {
      showLookupFailure(isRuntimeCompatBlockError(error) ? 'update' : 'unreachable')
    }
  }
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
      return lookUpOnOlderHost(party)
    }
    return isRuntimeCompatBlockError(error) ? 'update' : 'unreachable'
  }
}

/** A host before the lookup: a chat open here under its root id, as one never `/clear`ed is, or a
 *  terminal by its handle; anything else needs that host updated. */
function lookUpOnOlderHost(party: Sender['party']): Lookup {
  const sessionId = party.orcaSessionId
  if (sessionId) {
    const tabsByWorktree = useAppStore.getState().unifiedTabsByWorktree
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      if (tabs.some((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)) {
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

/** Words for a sender of any kind, each sentence translated whole as write notices are. */
function showLookupFailure(failure: LookupFailure): void {
  toast.error(
    agentSessionWriteNoticeText(
      failure === 'older-host'
        ? ['unsupported']
        : failure === 'update'
          ? ['updateOrcaToOpenChat']
          : ['unreachable', 'tryAgain']
    )
  )
}
