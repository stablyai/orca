import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

type LaunchAgentSessionContinuationArgs = {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
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

export async function launchAgentSessionContinuation({
  agent,
  prompt,
  worktreeId,
  groupId,
  initialCwd,
  launchSource
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  if (!(await ensureAgentAvailable(agent, worktreeId))) {
    return false
  }

  const label = getAgentLabel(agent)
  // Why: the paste helper writes blind when the agent's composer was never observed, so a
  // written prompt is not a delivered one. Claiming success there is how the whole handoff
  // could vanish silently (#22479).
  const promptDelivery = agent === 'claude' ? 'draft' : 'submit-after-ready'
  let deliveryUnconfirmed = false
  let createdTabId: string | undefined
  const executionHostId = useAppStore.getState().getKnownWorktreeById(worktreeId)?.hostId
  let result: ReturnType<typeof launchAgentInNewTab> = null
  result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    agent,
    worktreeId,
    ...(groupId ? { groupId } : {}),
    prompt,
    promptDelivery,
    launchSource,
    ...(initialCwd ? { initialCwd } : {}),
    onCreatedTab: (tabId) => {
      createdTabId = tabId
    },
    onPromptDeliveryUnconfirmed: () => {
      deliveryUnconfirmed = true
    },
    onPromptDelivered: () => {
      if (deliveryUnconfirmed) {
        notifyDeliveryUnconfirmed(label, prompt)
        return
      }
      // The launcher may report delivery before returning its tab identity.
      queueMicrotask(() => {
        if (!result) {
          return
        }
        const tabId =
          createdTabId ??
          (result.surface.kind !== 'host-published' ? result.surface.tabId : undefined)
        toast.success(
          translate(
            promptDelivery === 'draft'
              ? 'components.agentSessionContinuation.draftLoaded'
              : 'components.agentSessionContinuation.sent',
            promptDelivery === 'draft'
              ? 'Session context loaded as a draft in the new {{agent}} session. Review it and press Enter to continue.'
              : 'Session context sent to {{agent}} in a new session.',
            { agent: label }
          ),
          tabId
            ? {
                action: {
                  label: translate(
                    'components.agentSessionContinuation.openSession',
                    'Open session'
                  ),
                  onClick: () => {
                    const tab = (
                      useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
                    ).find(
                      (candidate) =>
                        candidate.id === tabId ||
                        (candidate.contentType === 'terminal' && candidate.entityId === tabId)
                    )
                    if (
                      tab &&
                      (tab.contentType === 'terminal' || tab.contentType === 'agent-session')
                    ) {
                      activateWorkspaceTabPaletteResult({
                        ...tab,
                        tabId: tab.id,
                        contentType: tab.contentType,
                        executionHostId
                      })
                    }
                  }
                }
              }
            : undefined
        )
      })
    }
  })
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
