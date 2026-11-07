// Open the sender through chat or terminal-handle routes; choose feedback from the answering host’s evidence, never the sender’s address shape.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import type { OrchestrationCrewRow } from '../../../shared/orchestration-crew'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import {
  openDesktopStructuredSession,
  structuredSessionOpenFeedbackText,
  type StructuredSessionOpenFeedback
} from './activate-ai-vault-structured-session'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
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
import { getKnownExecutionHostIdForWorktree } from './workspace/ownership/worktree-runtime-owner'
import {
  executionHostIdForStructuredTarget,
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

type Sender = AgentMessageSource['senders'][number]
const opensInFlight = new Map<string, Promise<void>>()

/** Route all sender lookups to the host of the chat displaying the message. */
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
    showLookupFailure('unreachable', label)
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
      showLookupFailure('unreachable', label)
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
  const state = useAppStore.getState()
  const root = party.orcaSessionId
  const known = root
    ? Object.entries(state.unifiedTabsByWorktree).flatMap(([worktreeId, tabs]) =>
        tabs.flatMap((tab) =>
          tab.contentType === 'agent-session' &&
          tab.entityId === root &&
          structuredAgentSessionOwnerForTab(state, tab) === executionHostIdForStructuredTarget(host)
            ? [{ sessionId: root, worktreeId, agent: tab.agentSessionAgent }]
            : []
        )
      )[0]
    : undefined
  const result = await openDesktopStructuredSession(
    {
      kind: 'sender',
      party,
      messageIds,
      displayName: name ?? undefined,
      ...(known ? { fallback: known } : {})
    },
    host
  )
  if (result.kind === 'terminal') {
    if (
      agentMessageSenderReplacedOnHandle(
        useAppStore.getState(),
        sender,
        executionHostIdForStructuredTarget(host),
        result.handle
      )
    ) {
      toast.info(agentMessageSenderUnavailableText({ kind: 'replaced' }, name))
      return
    }
    await focusTerminal(result.handle, environmentId, {
      lookupFailure: (failure) => showLookupFailure(failure, name)
    })
  }
}

/** Crew opens share the sender's host-aware navigation; mailbox identity is never a terminal handle. */
export async function openOrchestrationCrewAgent(
  row: OrchestrationCrewRow,
  host: RuntimeClientTarget
): Promise<void> {
  const unavailable = (detail: string) =>
    toast.error(
      translate('components.orchestrationCrew.openFailed', '{{name}}: {{detail}}', {
        name: row.label,
        detail
      })
    )
  const terminalExited = () =>
    unavailable(
      translate('components.orchestrationCrew.terminalExited', 'This terminal has exited.')
    )
  const target = row.openTarget
  // Lookups give the sender open's remedies, named for the row the user clicked.
  const feedback: StructuredSessionOpenFeedback =
    target?.kind === 'chat'
      ? {
          unavailable: () =>
            unavailable(
              translate(
                'components.orchestrationCrew.chatUnavailable',
                'This host cannot open the chat. Try again.'
              )
            ),
          gone: () => unavailable(structuredSessionOpenFeedbackText.gone()),
          hostCannotOpen: () => unavailable(structuredSessionOpenFeedbackText.hostCannotOpen())
        }
      : {
          unavailable: () => unavailable(structuredSessionOpenFeedbackText.unavailable()),
          hostCannotOpen: () => unavailable(structuredSessionOpenFeedbackText.hostCannotOpen()),
          gone: () => unavailable(structuredSessionOpenFeedbackText.gone()),
          terminalGone: terminalExited
        }
  const environmentId = host.kind === 'environment' ? host.environmentId : null
  const terminalFeedback = {
    gone: terminalExited,
    lookupFailure: (failure: LookupFailure) => showLookupFailure(failure, row.label, feedback)
  }
  try {
    if (target?.kind === 'terminal') {
      await focusTerminal(target.handle, environmentId, terminalFeedback)
      return
    }
    if (target?.kind !== 'chat' && target?.kind !== 'dispatch') {
      unavailable(
        row.hostLabel
          ? translate('components.orchestrationCrew.openOnHost', 'Open this agent on {{host}}.', {
              host: row.hostLabel
            })
          : translate(
              'components.orchestrationCrew.cannotLocate',
              'This host cannot locate this agent. Try again.'
            )
      )
      return
    }
    const result = await openDesktopStructuredSession(
      target.kind === 'chat'
        ? {
            kind: 'history',
            structuredSession: { workspaceId: target.worktreeId, sessionId: target.sessionId }
          }
        : {
            kind: 'sender',
            party: { address: target.address, terminalHandle: null, orcaSessionId: null },
            messageIds: [],
            displayName: row.label
          },
      host,
      undefined,
      undefined,
      feedback
    )
    if (result.kind === 'terminal') {
      await focusTerminal(result.handle, environmentId, terminalFeedback)
    }
  } catch (error) {
    showLookupFailure(
      isRuntimeCompatBlockError(error) ? 'update' : 'unreachable',
      row.label,
      feedback
    )
  }
}
