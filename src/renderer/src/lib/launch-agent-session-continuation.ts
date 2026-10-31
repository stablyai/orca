import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { ensureDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { useAppStore } from '@/store'
import {
  acquireAgentLaunchChoices,
  AgentLaunchChoiceCancelled
} from './host-chat-program-acquisition'
import { agentChoicePending } from './host-chat-program'
import { worktreeLaunchWorkspace } from './agent-launch-route-input'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  adoptAgentSessionLaunchVerdict,
  planAgentSessionLaunch
} from '@/lib/agent-session-launch-plan'
import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { workspaceNavigationToastAction } from '@/lib/workspace-navigation-toast-action'

type LaunchAgentSessionContinuationArgs = {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
  initialCwd?: string | null
  launchChoice?: AgentLaunchChoice
  launchSource: LaunchSource
  signal?: AbortSignal
}

/** Detected agents, then those that open as a chat on the workspace's host without their CLI. */
export function detectAgentSessionContinuationAgents(worktreeId: string, signal?: AbortSignal) {
  return acquireAgentLaunchChoices(
    worktreeLaunchWorkspace(worktreeId),
    () => ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId),
    signal
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
  signal
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  const label = getAgentLabel(agent)
  // Blind PTY writes do not prove prompt delivery; claiming success can hide a lost handoff (#22479).
  let deliveryUnconfirmed = false
  const delivery = {
    agent,
    worktreeId,
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
    requestId: newAgentLaunchRequestId(),
    workspace: worktreeLaunchWorkspace(worktreeId),
    tuiCustomization: { cwd: initialCwd }
  }
  // Capture preference routes before detection awaits; only deliberate picks demand a surface.
  const plan = launchChoice
    ? adoptAgentSessionLaunchVerdict({ ...request, ...launchChoice, worktreeId })
    : planAgentSessionLaunch(useAppStore.getState(), request)
  if (!(await ensureAgentAvailable(agent, worktreeId, plan.route, signal))) {
    return false
  }
  const state = useAppStore.getState()
  const executionHostId =
    plan.executionHostId ?? getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? undefined
  const workspace = state.getKnownWorktreeById(worktreeId, executionHostId)
  const workspaceName =
    (workspace && resolveWorktreeDisplayName(workspace)) || initialCwd || worktreeId
  const result = launchAgentInNewTab({ ...delivery, agentSessionLaunchPlan: plan })
  if (!result) {
    notifyLaunchFailed(label)
    return false
  }

  if (result.promptDeliveryResult) {
    void result.promptDeliveryResult
      .then((delivery) => {
        if (!delivery.delivered && !delivery.failureNotified) {
          notifyDeliveryFailed(label, prompt)
        }
      })
      .catch((error) => {
        console.error('Agent session continuation prompt delivery failed', error)
        notifyDeliveryFailed(label, prompt)
      })
  }
  return true
}

function notifyLaunchFailed(agentLabel: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.launchFailed',
      'Could not start a new {{agent}} session.',
      { agent: agentLabel }
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
