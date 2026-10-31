import { adoptingAgentOnHost } from '@/components/right-sidebar/ai-vault-session-resume-in-chat-launch'
import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { adoptsCliConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import { toHostSessionPaneKey } from '../../../shared/terminal-surface-id'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  conversationSwitchFailureText,
  conversationSwitchSourceKept,
  conversationSwitchUnsupportedText
} from './conversation-switch-feedback'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { supportsSwitchConsent } from '@/runtime/structured-agent-session-switch-consent'
import { createStructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { createBrowserUuid } from './browser-uuid'
import { captureSourceTerminal } from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import {
  pendingNativeChatCliSwitches as pending,
  conversationSwitchChanged
} from './pending-conversation-surface-switches'
import {
  agentSessionSwitchDeadline,
  AGENT_SESSION_SWITCH_CLIENT_MS,
  type AgentSessionSwitchResult
} from '../../../shared/agent-session-switch-execution'
import { AgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import { prepareAiVaultSessionForResume } from './ai-vault-session-resume-preparation'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'
import { runLegacyConversationSwitch } from './conversation-switch-legacy'
import {
  recordConversationSwitchFocus,
  uncapturedSwitchChat
} from './conversation-switch-focus-intent'
import {
  type ConversationSwitch,
  keyFor,
  pendingNow,
  rederiveConversationSwitch,
  conversationSwitchReplying,
  withConversationSwitchPlatform
} from './conversation-switch-state'

export { conversationSwitchFailureText } from './conversation-switch-feedback'

export function runCliChatResume(
  source: CliChatResumeSource,
  confirm?: ConfirmationDialogContextValue
): Promise<void> {
  return runConversationSwitch({ direction: 'chat', ...source, source, confirm }).then(
    () => undefined
  )
}
export function runNativeChatCliSwitch(
  args: Omit<ConversationSwitch, 'direction'> & { onComplete?: () => void }
): Promise<void> {
  return runConversationSwitch({ ...args, direction: 'terminal' })
    .then(() => undefined)
    .finally(args.onComplete)
}

/**
 * Consent, one RPC, one settle. The host stops the agent, prepares the other view at rest and
 * replaces the tab in one layout write; here the source tab only shows the pending state. Every
 * exit is visible: the tab is replaced, or it stays as it was with one message.
 */
export async function runConversationSwitch(args: ConversationSwitch): Promise<boolean> {
  if (pendingNow(args)) {
    return false
  }
  args = withConversationSwitchPlatform(args)
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  const hostId = parseExecutionHostId(args.executionHostId)?.id
  const feedback =
    args.feedback ?? ((message: string, kind: 'error' | 'info') => toast[kind](message))
  if (!target || !hostId) {
    feedback(conversationSwitchFailureText(new Error('host unavailable'), args), 'error')
    return false
  }
  const key = keyFor(args)
  pending.set(key, {
    chatTabId: args.source?.tabId ?? args.chatTabId ?? null,
    workspaceId: args.workspaceId,
    executionHostId: args.executionHostId
  })
  conversationSwitchChanged()
  let consented = false
  let sent = false
  let disposeDeadline: (() => void) | undefined
  let request: Awaited<ReturnType<typeof switchRequest>> | undefined
  try {
    const supported = await withinSwitchBudget(supportsInPlaceSwitch(target, args.agent, true))
    // The chat's surfaces offer the copy where the host can't switch; a click that raced the
    // host's answer stops nothing and says so.
    if (!supported && args.direction === 'terminal') {
      feedback(conversationSwitchUnsupportedText(args.agent), 'error')
      return false
    }
    const confirmStop = async (): Promise<boolean> =>
      (await args.confirm?.({
        title: translate(
          'components.tab.bar.switch.stopAndSwitchTitle',
          '{{agent}} is replying. Stop it and switch?',
          { agent: agentLabel(args.agent) }
        ),
        confirmLabel: translate('components.tab.bar.switch.stopAndSwitch', 'Stop and switch'),
        cancelLabel: translate('common.cancel', 'Cancel'),
        compact: true,
        ignoresOpeningGesture: true
      })) === true
    // A host that decides consent refuses a replying agent itself; this client's copy of the
    // agent's status is never permission to stop it, nor a reason to ask.
    const hostConsents = supported && (await withinSwitchBudget(supportsSwitchConsent(target)))
    if (!hostConsents && conversationSwitchReplying(args) && !(await confirmStop())) {
      return false
    }
    consented = true
    // An agent or host without the in-place switch keeps the earlier chat resume.
    if (!supported) {
      await runLegacyConversationSwitch(args, target)
      return false
    }
    let consent = hostConsents ? false : undefined
    let answer: AgentSessionSwitchResult
    for (;;) {
      // Time spent answering the consent dialog is not the switch's budget.
      const deadline = agentSessionSwitchDeadline(Date.now, AGENT_SESSION_SWITCH_CLIENT_MS)
      disposeDeadline = deadline.dispose
      request ??= await switchRequest(args, hostId, deadline)
      answer = await deadline.wait(
        callStructuredAgentSession<AgentSessionSwitchResult>(
          target,
          args.direction === 'chat' ? 'agentSession.switchToChat' : 'agentSession.switchToTerminal',
          {
            sessionId: request.sessionId,
            execution: {
              ...request.execution,
              ...(consent === undefined ? {} : { consented: consent })
            }
          },
          {
            signal: deadline.signal,
            dispatchObservation: deadline.delegateSend,
            onSent: (sentAt) => {
              deadline.beforeSend(sentAt)
              sent = true
            }
          }
        )
      )
      deadline.dispose()
      const needsConsent =
        consent === false &&
        answer.status === 'refused' &&
        answer.refusal.details?.reason === 'turnActive'
      if (!needsConsent) {
        break
      }
      // The host stopped nothing. A yes is a new switch under its own invocation, never a replay.
      if (!(await confirmStop())) {
        request.abandonFocus?.()
        return false
      }
      consent = true
      sent = false
      request = {
        ...request,
        execution: { ...request.execution, invocationId: createBrowserUuid() }
      }
    }
    if (answer.status !== 'completed') {
      if (answer.status === 'refused') {
        request?.abandonFocus?.()
      }
      feedback(
        conversationSwitchFailureText(new AgentSessionRefusalError(answer.refusal), args),
        'error'
      )
      return false
    }
    if (answer.sourceRetained) {
      feedback(conversationSwitchSourceKept(args.agent), 'info')
    }
    return true
  } catch (error) {
    // Once the request left, a failure that isn't the host's answer can't say what the host did.
    const unknown = sent && !structuredLaunchFailure(error)
    // Only an answer that may still arrive keeps this client's claim on where the chat lands.
    if (!unknown) {
      request?.abandonFocus?.()
    }
    feedback(
      conversationSwitchFailureText(error, args, unknown ? 'outcomeUnknown' : undefined),
      'error'
    )
    return false
  } finally {
    disposeDeadline?.()
    pending.delete(key)
    conversationSwitchChanged()
    if (consented) {
      rederiveConversationSwitch(args)
    }
  }
}

/** The capability read before consent gets the same budget as the switch, but its own clock. */
async function withinSwitchBudget<T>(work: Promise<T>): Promise<T> {
  const budget = agentSessionSwitchDeadline(Date.now, AGENT_SESSION_SWITCH_CLIENT_MS)
  try {
    return await budget.wait(work)
  } finally {
    budget.dispose()
  }
}

/** The host call's identity and execution facts, captured after consent. */
async function switchRequest(
  args: ConversationSwitch,
  hostId: ExecutionHostId,
  deadline: ReturnType<typeof agentSessionSwitchDeadline>
): Promise<{
  sessionId: string | undefined
  execution: Record<string, unknown>
  abandonFocus?: () => void
}> {
  const invocationId = createBrowserUuid()
  const captured =
    args.direction === 'chat' && args.source
      ? await deadline.wait(captureSourceTerminal(args.source))
      : null
  // A pane that can't be captured (a paired host's pane whose shell exited has lost its binding)
  // opens the conversation as a selected chat right after its tab, with no terminal to stop;
  // History takes its own row's route.
  if (args.direction === 'chat' && args.source && (captured || !args.history)) {
    const intent = createStructuredAgentSessionLaunchIntent(
      args.workspaceId,
      await deadline.wait(
        adoptingAgentOnHost(args.source.agent, args.workspaceId, args.source.executionHostId)
      ),
      args.source.executionHostId,
      {
        providerSessionId: args.source.providerSessionId,
        cliSource: {
          workspaceId: args.workspaceId,
          paneKey: toHostSessionPaneKey(args.source.paneKey)
        }
      },
      undefined,
      false
    )
    if (!captured) {
      return uncapturedSwitchChat(intent, invocationId, args.source.tabId)
    }
    return {
      sessionId: intent.sessionId,
      abandonFocus: recordConversationSwitchFocus({
        target: captured.target,
        workspaceId: args.workspaceId,
        sourceTabId: args.source.tabId,
        hostSourceTabId: captured.presentation?.identity.tabId,
        chatSessionId: intent.sessionId
      }),
      execution: {
        invocationId,
        create: intent.params,
        source: {
          terminal: captured.handle,
          expectedIncarnationId: captured.incarnationId,
          originalPresentation: captured.presentation
        }
      }
    }
  }
  if (
    args.direction === 'chat' &&
    !args.sessionId &&
    args.history &&
    adoptsCliConversations(args.history.agent)
  ) {
    const prepared = await deadline.wait(prepareAiVaultSessionForResume(args.history))
    const intent = createStructuredAgentSessionLaunchIntent(
      args.workspaceId,
      await deadline.wait(adoptingAgentOnHost(args.history.agent, args.workspaceId, hostId)),
      hostId,
      { providerSessionId: prepared.sessionId },
      undefined,
      false
    )
    return uncapturedSwitchChat(intent, invocationId, args.source?.tabId)
  }
  if (args.direction === 'terminal') {
    return {
      sessionId: args.sessionId,
      execution: {
        invocationId,
        sourceTabId: args.chatTabId ?? undefined,
        commandOverride: useAppStore.getState().settings?.agentCmdOverrides?.[args.agent]
      }
    }
  }
  // An existing chat (History's row names it) opens selected for this client, as a new one does.
  const target = structuredAgentSessionTargetForHost(hostId)
  if (args.direction === 'chat' && args.sessionId && target) {
    return uncapturedSwitchChat(
      { target, worktreeId: args.workspaceId, sessionId: args.sessionId },
      invocationId,
      args.source?.tabId
    )
  }
  return { sessionId: args.sessionId, execution: { invocationId } }
}

export {
  useConversationSwitchPending,
  useConversationSwitchBusy,
  useConversationSwitchReadiness,
  type ConversationSwitch
} from './conversation-switch-state'
