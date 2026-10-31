// Open the sender the card resolved; an older host's lookup chooses feedback from its own evidence, never the sender's address shape.

import { toast } from 'sonner'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import type {
  OrchestrationPartyLocation,
  OrchestrationPartyLocationResult
} from '../../../shared/orchestration-caller-status'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
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
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import {
  resolveAgentMessageSender,
  UNPROVED_SENDER_CLICK,
  type LocatedAgentSender
} from '@/runtime/agent-sender-associations'
import { agentMessageSenderOwner } from '@/components/native-chat/native-chat-agent-message-sender-label'
import { activateWorktreeAgentPane } from '@/components/sidebar/use-worktree-agent-activation'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  executionHostIdForStructuredTarget,
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

type Sender = AgentMessageSource['senders'][number]
/** older-host identifies the chat host; update may mean either side, and unreachable proves nothing. */
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

/** Open what the card's own sender resolution names; only an older host, or a chat the host can
 *  still reopen, goes back to the host lookup. */
export function openAgentMessageSender(
  source: AgentMessageSource,
  sender: Sender,
  chatWorktreeId: string,
  target?: RuntimeClientTarget,
  dispatchId?: string
): Promise<void> {
  const state = useAppStore.getState()
  const owner = agentMessageSenderOwner(state, chatWorktreeId, target)
  // Read at click time, so a stale render cannot open what the host has since rejected.
  const resolution = owner
    ? resolveAgentMessageSender(state, owner, sender, dispatchId)
    : { kind: 'legacy' as const }
  if (resolution.kind === 'located') {
    return openLocatedSender(resolution.location)
  }
  const hostLookup =
    resolution.kind === 'legacy' ||
    (resolution.kind === 'gone' && resolution.chat) ||
    (resolution.kind === 'unproved' && UNPROVED_SENDER_CLICK === 'legacy-lookup')
  if (!hostLookup) {
    showAgentPaneUnavailable()
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
  const opening = openSender(source, sender, host)
    .catch((error: unknown) => {
      // Every answer above shows its own words; one that threw showed none.
      console.warn('[agent-message-sender] opening the sender failed', error)
      showLookupFailure('unreachable')
    })
    .finally(() => opensInFlight.delete(key))
  opensInFlight.set(key, opening)
  return opening
}

/** The located pane or chat itself, through the same activation its sidebar row uses. */
async function openLocatedSender(location: LocatedAgentSender): Promise<void> {
  if (location.sessionId) {
    const host = structuredAgentSessionTargetForHost(location.host)
    if (!host) {
      showLookupFailure('unreachable')
      return
    }
    const session = {
      structuredSession: { workspaceId: location.worktreeId, sessionId: location.sessionId }
    }
    await activateAiVaultStructuredSession(session, undefined, host)
    return
  }
  const tabId = parsePaneKey(location.paneKey)?.tabId
  if (!tabId) {
    showAgentPaneUnavailable()
    return
  }
  activateWorktreeAgentPane(location.worktreeId, tabId, location.paneKey)
}

async function openSender(
  source: AgentMessageSource,
  { party }: Sender,
  host: RuntimeClientTarget
): Promise<void> {
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
