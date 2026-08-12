import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

type LaunchAgentSessionContinuationArgs = {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
  workspacePath: string
  initialCwd?: string | null
  launchSource: LaunchSource
}

export async function detectAgentSessionContinuationAgents(
  worktreeId: string
): Promise<TuiAgent[]> {
  const state = useAppStore.getState()
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return connectionId
    ? state.ensureRemoteDetectedAgents(connectionId)
    : runtimeEnvironmentId
      ? state.ensureRuntimeDetectedAgents(runtimeEnvironmentId)
      : state.ensureDetectedAgents(worktreeId)
}

async function ensureAgentAvailable(agent: TuiAgent, worktreeId: string): Promise<boolean> {
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

  let detectedAgents: TuiAgent[]
  try {
    detectedAgents = await detectAgentSessionContinuationAgents(worktreeId)
  } catch (error) {
    console.error('Agent detection failed for session continuation', error)
    detectedAgents = []
  }
  if (detectedAgents.includes(agent)) {
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

async function preflightAgentTrust(args: {
  agent: TuiAgent
  workspacePath: string
  connectionId: string | null | undefined
}): Promise<void> {
  const preset = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preset || !args.workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Why: a failed best-effort trust write should not discard a prepared handoff.
  }
}

export async function launchAgentSessionContinuation({
  agent,
  prompt,
  worktreeId,
  groupId,
  workspacePath,
  initialCwd,
  launchSource
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  if (!(await ensureAgentAvailable(agent, worktreeId))) {
    return false
  }

  const connectionId = getConnectionIdFromState(useAppStore.getState(), worktreeId)
  await preflightAgentTrust({ agent, workspacePath, connectionId })

  const label = getAgentLabel(agent)
  const result = launchAgentInNewTab({
    agent,
    worktreeId,
    ...(groupId ? { groupId } : {}),
    prompt,
    promptDelivery: 'submit-after-ready',
    launchSource,
    ...(initialCwd ? { initialCwd } : {}),
    onPromptDelivered: () =>
      toast.success(
        translate(
          'components.agentSessionContinuation.sent',
          'Session context sent to {{agent}} in a new session.',
          { agent: label }
        )
      )
  })
  if (!result) {
    notifyLaunchFailed(label)
    return false
  }

  if (result.promptDeliveryResult) {
    void result.promptDeliveryResult
      .then((delivery) => {
        if (!delivery.delivered && !delivery.failureNotified) {
          notifyDeliveryFailed(label)
        }
      })
      .catch((error) => {
        console.error('Agent session continuation prompt delivery failed', error)
        notifyDeliveryFailed(label)
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

function notifyDeliveryFailed(agentLabel: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.deliveryFailed',
      'The new {{agent}} session started, but its context could not be sent.',
      { agent: agentLabel }
    )
  )
}
