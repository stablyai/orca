import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { ensureDetectedAgentsForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'

import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { useAppStore } from '@/store/index'
import {
  acquireAgentLaunchChoices,
  AgentLaunchChoiceCancelled
} from '../inventory/host-chat-program-acquisition'
import { agentChoicePending } from '../inventory/host-chat-program'
import { worktreeLaunchWorkspace } from '../routing/agent-launch-route-input'
import { isTuiAgentEnabled } from '../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { LaunchSource } from '../../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  adoptAgentSessionLaunchVerdict,
  planAgentSessionLaunch
} from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { AgentLaunchChoice } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import type { AgentLaunchRoute } from '@/lib/agent-session/launch/routing/agent-launch-routing'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { workspaceNavigationToastAction } from '@/lib/workspace/activation/workspace-navigation-toast-action'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { waitForTerminalHandoffSubmission } from './terminal-handoff-submission'

type LaunchAgentSessionContinuationArgs = {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
  initialCwd?: string | null
  launchChoice?: AgentLaunchChoice
  launchSource: LaunchSource
  signal?: AbortSignal
  interruptOriginal?: { signal: AbortSignal; run: (signal: AbortSignal) => Promise<boolean> }
  sessionOptions?: Readonly<Record<string, string>>
  chatSessionOptions?: Readonly<Record<string, string>>
  agentArgs?: string | null
}

/** Detected agents, then those that open as a chat on the workspace's host without their CLI. */
export function detectAgentSessionContinuationAgents(worktreeId: string, signal?: AbortSignal) {
  return acquireAgentLaunchChoices(
    worktreeLaunchWorkspace(worktreeId),
    () => ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId),
    signal
  )
}

export function supportsContinuationInterruptDestination(choice?: AgentLaunchChoice): boolean {
  return (
    choice?.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    choice.agent !== 'claude' &&
    (choice.route === 'structured-native-chat' || choice.agent === 'codex')
  )
}

async function ensureAgentAvailable(
  agent: TuiAgent,
  worktreeId: string,
  route: AgentLaunchRoute,
  signal?: AbortSignal
): Promise<boolean> {
  const state = useAppStore.getState()
  const label = getAgentLabel(agent)
  if (!isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    toast.error(
      translate(
        'components.agentSessionContinuation.agentDisabled',
        '{{agent}} is disabled in Agent settings.',
        { agent: label }
      )
    )
    return false
  }

  let choices: { detected: readonly TuiAgent[] | null; offered: readonly TuiAgent[] }
  try {
    choices = await detectAgentSessionContinuationAgents(worktreeId, signal)
  } catch (error) {
    if (error instanceof AgentLaunchChoiceCancelled) {
      return false
    }
    console.error('Agent detection failed for session continuation', error)
    choices = { detected: [], offered: [] }
  }
  // A terminal runs the agent's CLI; only a chat can open through a host-run chat program.
  if (
    route === 'terminal-tui'
      ? choices.detected?.includes(agent)
      : choices.offered.includes(agent) ||
        agentChoicePending(useAppStore.getState(), agent, worktreeLaunchWorkspace(worktreeId), null)
  ) {
    return true
  }

  toast.error(
    translate(
      'components.agentSessionContinuation.agentUnavailable',
      '{{agent}} was not detected on this workspace host.',
      { agent: label }
    )
  )
  return false
}

export async function launchAgentSessionContinuation({
  agent,
  prompt,
  worktreeId,
  groupId,
  initialCwd,
  launchChoice,
  launchSource,
  signal,
  interruptOriginal,
  sessionOptions,
  chatSessionOptions,
  agentArgs
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  const label = getAgentLabel(agent)
  // Blind PTY writes do not prove prompt delivery; claiming success can hide a lost handoff (#22479).
  let deliveryUnconfirmed = false
  const delivery = {
    agent,
    worktreeId,
    ...(sessionOptions ? { sessionOptions: { ...sessionOptions } } : {}),
    ...(chatSessionOptions !== undefined ? { chatSessionOptions: { ...chatSessionOptions } } : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(groupId ? { groupId } : {}),
    prompt,
    promptDelivery: agent === 'claude' ? ('draft' as const) : ('submit-after-ready' as const),
    launchSource,
    ...(initialCwd ? { initialCwd } : {}),
    onPromptDeliveryUnconfirmed: () => {
      deliveryUnconfirmed = true
    },
    onPromptDelivered: () => {
      if (deliveryUnconfirmed) {
        notifyDeliveryUnconfirmed(label, prompt)
        return
      }
      toast.success(
        translate(
          'components.agentSessionContinuation.sent',
          'Session context sent to {{agent}} in a new session.',
          { agent: label }
        ),
        {
          description: workspaceName,
          duration: Infinity,
          dismissible: true,
          action: workspaceNavigationToastAction({
            workspaceId: worktreeId,
            executionHostId
          })
        }
      )
    }
  }
  const request = {
    ...delivery,
    ...(delivery.sessionOptions ? { launchOptions: delivery.sessionOptions } : {}),
    ...(delivery.chatSessionOptions !== undefined
      ? { chatLaunchOptions: delivery.chatSessionOptions }
      : {}),
    requestId: createNonSecureContextUuid(),
    workspace: worktreeLaunchWorkspace(worktreeId),
    tuiCustomization: { cwd: initialCwd }
  }
  // Capture preference routes before detection awaits; only deliberate picks demand a surface.
  const plan = launchChoice
    ? adoptAgentSessionLaunchVerdict({ ...request, ...launchChoice, worktreeId })
    : planAgentSessionLaunch(useAppStore.getState(), request)
  // A dialog closed while detection ran must not start the session the user just left.
  if (!(await ensureAgentAvailable(agent, worktreeId, plan.route, signal)) || signal?.aborted) {
    return false
  }
  const state = useAppStore.getState()
  const executionHostId =
    plan.executionHostId ?? getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? undefined
  const workspace = state.getKnownWorktreeById(worktreeId, executionHostId)
  const workspaceName =
    (workspace && resolveWorktreeDisplayName(workspace)) || initialCwd || worktreeId
  const interrupt = supportsContinuationInterruptDestination({
    agent,
    route: plan.route,
    executionHostId
  })
    ? interruptOriginal
    : undefined
  const startedAt = Date.now()
  const result = launchAgentInNewTabWithOutcome({ ...delivery, agentSessionLaunchPlan: plan })
  if (!result || 'refused' in result) {
    return false
  }
  // A launch still waiting on its host has opened nothing yet: the handoff counts once a chat or
  // terminal exists, so a declined or cancelled one leaves the dialog open to retry.
  if (result.surface.kind === 'host-published' && result.structuredSettlement) {
    const settled = await result.structuredSettlement
    if (settled.kind === 'cancelled' || settled.kind === 'failed') {
      return false
    }
  }

  if (result.promptDeliveryResult) {
    void result.promptDeliveryResult
      .then((delivery) => {
        if (!delivery.delivered && !delivery.failureNotified && !delivery.unconfirmed) {
          notifyDeliveryFailed(label, prompt)
        }
      })
      .catch((error) => {
        console.error('Agent session continuation prompt delivery failed', error)
        notifyDeliveryFailed(label, prompt)
      })
  }
  if (interrupt) {
    // The new session can activate before delivery settles and unmount the dialog.
    const observation = new AbortController()
    const tabId = result.surface.kind === 'local-terminal' ? result.surface.tabId : null
    const terminal = plan.route === 'terminal-tui' ? result.terminalPromptTarget : undefined
    const submitted =
      tabId && terminal
        ? terminal.started
            .then((ptyId) =>
              ptyId
                ? waitForTerminalHandoffSubmission({
                    tabId,
                    leafId: terminal.leafId,
                    ptyId,
                    startedAt,
                    prompt,
                    signal: AbortSignal.any([observation.signal, interrupt.signal])
                  })
                : false
            )
            .catch(() => false)
        : null
    void (async () => {
      const receipt = await result.promptDeliveryResult
      if (
        interrupt.signal.aborted ||
        !receipt?.delivered ||
        receipt.unconfirmed ||
        deliveryUnconfirmed
      ) {
        return
      }
      const settlement = await result.structuredSettlement
      const opening =
        settlement?.kind === 'structured' ? await settlement.promptDeliveryResult : null
      const destinationConfirmed =
        plan.route === 'terminal-tui'
          ? (await submitted) === true
          : opening?.delivered === true && !opening.unconfirmed && !opening.inComposer
      if (interrupt.signal.aborted) {
        return
      }
      const interrupted = destinationConfirmed && (await interrupt.run(interrupt.signal))
      if (!interrupted && !interrupt.signal.aborted) {
        notifyInterruptUnconfirmed()
      }
    })()
      .catch(() => {
        if (!interrupt.signal.aborted) {
          notifyInterruptUnconfirmed()
        }
      })
      .finally(() => observation.abort())
  }
  return true
}

function notifyInterruptUnconfirmed(): void {
  toast.warning(
    translate(
      'components.agentSessionContinuation.interruptUnconfirmed',
      'Could not confirm the original agent was interrupted. Check its terminal.'
    )
  )
}

function notifyDeliveryFailed(agentLabel: string, prompt: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.deliveryFailed',
      'The new {{agent}} session started, but its context could not be sent.',
      { agent: agentLabel }
    ),
    copyPromptToastAction(prompt)
  )
}

/** The prompt was written to the PTY but the agent never showed an input-ready composer. */
function notifyDeliveryUnconfirmed(agentLabel: string, prompt: string): void {
  toast.warning(
    translate(
      'components.agentSessionContinuation.deliveryUnconfirmed',
      'Orca could not confirm {{agent}} received the session context. Check the new session, and paste it yourself if its input is empty.',
      { agent: agentLabel }
    ),
    copyPromptToastAction(prompt)
  )
}

function copyPromptToastAction(prompt: string): {
  action: { label: string; onClick: () => void }
} {
  return {
    action: {
      label: translate('components.agentSessionContinuation.copyPrompt', 'Copy prompt'),
      onClick: () => {
        void window.api.ui.writeClipboardText(prompt)
      }
    }
  }
}
