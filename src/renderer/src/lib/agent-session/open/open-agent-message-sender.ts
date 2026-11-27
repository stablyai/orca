// Open the sender through chat or terminal-handle routes; choose feedback from the answering host’s evidence, never the sender’s address shape.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import {
  openDesktopStructuredSession,
  structuredSessionOpenFeedbackText
} from './activate-ai-vault-structured-session'
import { showChatOpenUnavailable } from './chat-open-failure-toast'
import type { StructuredSessionOpenFeedback } from './activate-ai-vault-structured-session'
import { useAppStore } from '@/store/index'
import {
  focusTerminal,
  openLocatedAgentMessageSender,
  showLookupFailure
} from './open-located-agent-message-sender'
import type { LookupFailure } from './open-located-agent-message-sender'
import {
  agentMessageSenderOpens,
  agentMessageSenderReplacedOnHandle,
  agentMessageSenderUnavailableText,
  resolveAgentMessageSenderTarget
} from '@/components/native-chat/messages/agent-senders/native-chat-agent-message-sender-target'
import { getKnownExecutionHostIdForWorktree } from '../../workspace/ownership/worktree-runtime-owner'
import {
  executionHostIdForStructuredTarget,
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { OrchestrationCrewRow } from '../../../../../shared/orchestration/orchestration-crew'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { unreachableOpenFailure } from '../../../../../shared/agent-session/view/structured-session-open-failure-detail'
import { agentMessageSavedName } from '../../../../../shared/agent-session/view/messages/agent-message-presentation'

type Sender = AgentMessageSource['senders'][number]
const opensInFlight = new Map<string, Promise<void>>()

/** Route all sender lookups to the host of the chat displaying the message. */
export function openAgentMessageSender(
  source: AgentMessageSource,
  sender: Sender,
  chatWorktreeId: string,
  target?: RuntimeClientTarget,
  dispatchId?: string,
  name?: string | null
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
  // A blank snapshot name names no one, so the unavailable toast keeps its "An agent" subject.
  const label = name ?? agentMessageSavedName(sender) ?? undefined
  const reopen = () =>
    openAgentMessageSender(source, sender, chatWorktreeId, target, dispatchId, name)
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
      reopen
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
  const opening = openSender(source, sender, host, label, reopen)
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
  name: string | undefined,
  retry: () => Promise<void>
): Promise<void> {
  const { party } = sender
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
      displayName: name,
      ...(known ? { fallback: known } : {})
    },
    { target: host, retry }
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
    await focusTerminal(result.handle, terminalEnvironmentId(host, result), {
      lookupFailure: (failure) => showLookupFailure(failure, name)
    })
  }
}

type TerminalFocusFeedback = Parameters<typeof focusTerminal>[2]

/** The server a located terminal runs on: the answering host, or the paired server this desktop's own
 *  host says started it (a remote host's server ids name its own pairings, not this desktop's). */
export function terminalEnvironmentId(
  host: RuntimeClientTarget,
  result: { environmentId?: string }
): string | null {
  return host.kind === 'environment' ? host.environmentId : (result.environmentId ?? null)
}

/** Opens an orchestration party by address on its host; a terminal worker Orca closed reopens there. */
export async function openOrchestrationDispatch(
  address: string,
  label: string,
  host: RuntimeClientTarget,
  feedback?: { open?: StructuredSessionOpenFeedback; terminal?: TerminalFocusFeedback }
): Promise<void> {
  const terminal = feedback?.terminal ?? {
    lookupFailure: (failure: LookupFailure) => showLookupFailure(failure, label, feedback?.open)
  }
  try {
    const result = await openDesktopStructuredSession(
      {
        kind: 'sender',
        party: { address, terminalHandle: null, orcaSessionId: null },
        messageIds: [],
        displayName: label
      },
      {
        target: host,
        feedback: feedback?.open,
        retry: () => openOrchestrationDispatch(address, label, host, feedback)
      }
    )
    if (result.kind === 'terminal') {
      await focusTerminal(result.handle, terminalEnvironmentId(host, result), terminal)
    }
  } catch (error) {
    showLookupFailure(
      isRuntimeCompatBlockError(error) ? 'update' : 'unreachable',
      label,
      feedback?.open
    )
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
          unavailable: (_agent, context) => showChatOpenUnavailable(context, row.label),
          gone: () => unavailable(structuredSessionOpenFeedbackText.gone()),
          hostCannotOpen: () => unavailable(structuredSessionOpenFeedbackText.hostCannotOpen()),
          notLocated: () => unavailable(structuredSessionOpenFeedbackText.notLocated())
        }
      : {
          unavailable: (_agent, context) => showChatOpenUnavailable(context, row.label),
          hostCannotOpen: () => unavailable(structuredSessionOpenFeedbackText.hostCannotOpen()),
          gone: () => unavailable(structuredSessionOpenFeedbackText.gone()),
          notLocated: () => unavailable(structuredSessionOpenFeedbackText.notLocated()),
          terminalGone: terminalExited
        }
  const environmentId = host.kind === 'environment' ? host.environmentId : null
  const terminalFeedback = {
    gone: terminalExited,
    lookupFailure: (failure: LookupFailure) => showLookupFailure(failure, row.label, feedback)
  }
  if (target?.kind === 'dispatch') {
    await openOrchestrationDispatch(target.address, row.label, host, {
      open: feedback,
      terminal: terminalFeedback
    })
    return
  }
  try {
    if (target?.kind === 'terminal') {
      await focusTerminal(target.handle, environmentId, terminalFeedback)
      return
    }
    if (target?.kind !== 'chat') {
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
      {
        kind: 'history',
        structuredSession: { workspaceId: target.worktreeId, sessionId: target.sessionId }
      },
      { target: host, feedback, retry: () => openOrchestrationCrewAgent(row, host) }
    )
    if (result.kind === 'terminal') {
      await focusTerminal(result.handle, terminalEnvironmentId(host, result), terminalFeedback)
    }
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      feedback.hostCannotOpen(row.label)
    } else if (target?.kind === 'chat') {
      feedback.unavailable(row.label, {
        detail: unreachableOpenFailure(error).detail,
        retry: () => void openOrchestrationCrewAgent(row, host)
      })
    } else {
      showLookupFailure('unreachable', row.label, feedback)
    }
  }
}
