import type { SelectedSourceControlActionRecipe } from '../../../../../../shared/source-control-action-selection'
import { ensureAgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from '@/lib/host-chat-program-acquisition'
import { toast } from 'sonner'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { settleAgentTabLaunch } from '@/lib/launch-agent-in-new-tab-host-agents'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { getConnectionId } from '@/lib/connection-context'
import {
  ensureDetectedAgentsForWorktree,
  type WorktreeAgentInventoryState
} from '@/lib/agent-detection-target-inventory'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../../../../shared/source-control-launch-agent-selection'
import { isTuiAgentEnabled } from '../../../../../../shared/tui-agent-selection'
import { projectSelectedSourceControlActionLaunch } from '../../../../../../shared/source-control-action-launch-preferences'
import type { SourceControlLaunchActionId } from '../../../../../../shared/source-control-ai-actions'
import { buildSourceControlRecoveryAgentCommandInput } from '../../../../../../shared/source-control-recovery-agent-command'
import { translate } from '@/i18n/i18n'
import { agentChoiceMayOpenAsChat } from '@/lib/host-chat-program'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'

type SourceControlAiLaunchStoreSnapshot = Pick<AppState, 'settings'> & WorktreeAgentInventoryState

export type SourceControlRecoveryLaunchCopy = {
  promptUnavailable: string
  emptyPrompt: string
  savedAgentUnavailable: string
  noEnabledAgent: string
  launchCommandUnavailable: string
  connectionUnavailable: string
  success: string
}

export function getDefaultSourceControlRecoveryLaunchCopy(
  recoveryKind: 'commit' | 'push'
): SourceControlRecoveryLaunchCopy {
  const subject = recoveryKind === 'push' ? 'push' : 'commit'
  return {
    promptUnavailable: translate(
      'auto.components.right.sidebar.source.control.ai.recovery.launch.4f4e0418a0',
      'Could not build the agent prompt.'
    ),
    emptyPrompt:
      recoveryKind === 'push'
        ? translate(
            'auto.components.right.sidebar.source.control.ai.recovery.launch.push.empty',
            'Push failure prompt is empty. Update Source Control AI settings.'
          )
        : translate(
            'auto.components.right.sidebar.source.control.ai.recovery.launch.commit.empty',
            'Commit failure prompt is empty. Update Source Control AI settings.'
          ),
    savedAgentUnavailable: translate(
      'auto.components.right.sidebar.source.control.ai.recovery.launch.d481ab22f9',
      'Saved AI agent is unavailable. Use Customize launch to choose another agent.'
    ),
    noEnabledAgent: translate(
      'auto.components.right.sidebar.source.control.ai.recovery.launch.9bbd9077a2',
      'No enabled AI agents. Configure agents in Settings.'
    ),
    launchCommandUnavailable: translate(
      'auto.components.right.sidebar.source.control.ai.recovery.launch.5540ff50cc',
      'Could not build the agent launch command.'
    ),
    connectionUnavailable: translate(
      'auto.components.right.sidebar.source.control.ai.recovery.launch.216f762bd7',
      'Unable to resolve the workspace connection.'
    ),
    success: translate(
      'auto.components.right.sidebar.source.control.ai.recovery.launch.success',
      'Started an AI agent for the {{value0}} failure.',
      { value0: subject }
    )
  }
}

export async function launchSourceControlRecoveryAgentWithDefault({
  activeWorktreeId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  sourceRepoConnectionId,
  actionId,
  basePrompt,
  promptOverride,
  getLaunchActionRecipe,
  getStoreState,
  copy
}: {
  activeWorktreeId: string
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform | undefined
  sourceRepoConnectionId?: string | null
  actionId: SourceControlLaunchActionId
  basePrompt: string | null
  promptOverride?: string
  getLaunchActionRecipe: (
    actionId: SourceControlLaunchActionId
  ) => SelectedSourceControlActionRecipe
  getStoreState: () => SourceControlAiLaunchStoreSnapshot
  copy: SourceControlRecoveryLaunchCopy
}): Promise<boolean> {
  const worktreeConnectionId = getConnectionId(activeWorktreeId)
  const connectionId =
    worktreeConnectionId !== undefined ? worktreeConnectionId : sourceRepoConnectionId
  if (connectionId === undefined) {
    toast.error(copy.connectionUnavailable)
    return false
  }

  const savedRecipe = getLaunchActionRecipe(actionId)
  const workspace = worktreeLaunchWorkspace(activeWorktreeId)
  const inventory = await Promise.all([
    acquireAgentLaunchChoices(workspace, () =>
      ensureDetectedAgentsForWorktree(getStoreState(), activeWorktreeId)
    ),
    ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  ]).catch((error) => {
    if (
      error instanceof AgentLaunchChoiceCancelled ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      return null
    }
    throw error
  })
  if (!inventory) {
    return false
  }
  const [choices, preferences] = inventory
  const detectedAgents = [...(choices.detected ?? [])]
  const store = getStoreState()
  if (!basePrompt) {
    toast.error(copy.promptUnavailable)
    return false
  }
  const prompt = buildSourceControlRecoveryAgentCommandInput({
    actionId,
    promptOverride,
    commandInputTemplate: savedRecipe.commandInputTemplate,
    basePrompt
  })
  if (!prompt) {
    toast.error(copy.emptyPrompt)
    return false
  }

  // A saved or default agent may open as a chat without its CLI.
  const opensAsChat = (agent: TuiAgent): boolean =>
    agentChoiceMayOpenAsChat(useAppStore.getState(), agent, workspace, choices.detected)
  const savedAgent = readSourceControlLaunchRecipeAgentId(savedRecipe)
  if (
    savedAgent &&
    ((!detectedAgents.includes(savedAgent) && !opensAsChat(savedAgent)) ||
      !isTuiAgentEnabled(savedAgent, preferences.disabledTuiAgents))
  ) {
    toast.error(copy.savedAgentUnavailable)
    return false
  }
  const agent = pickSourceControlLaunchAgent({
    savedAgent,
    defaultAgent: preferences.defaultTuiAgent,
    detectedAgents,
    disabledAgents: preferences.disabledTuiAgents,
    chosenOpensAsChat: opensAsChat
  })
  if (!agent) {
    toast.error(copy.noEnabledAgent)
    return false
  }
  const { commandInput, ...projection } = projectSelectedSourceControlActionLaunch(
    savedRecipe,
    agent,
    {
      renderedPrompt: prompt,
      settings: store.settings
    }
  )
  const result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    agent,
    worktreeId: activeWorktreeId,
    groupId: activeGroupId ?? activeWorktreeId,
    prompt: commandInput,
    ...projection,
    promptDelivery: 'submit-after-ready',
    launchPlatform: activeSourceControlLaunchPlatform,
    launchSource: 'source_control_recovery'
  })
  if (!result) {
    toast.error(copy.launchCommandUnavailable)
    return false
  }

  const settled = await settleAgentTabLaunch(result)
  if (settled.kind !== 'terminal' && settled.kind !== 'structured') {
    return false
  }
  const delivery =
    result.promptDeliveryResult ??
    (settled.kind === 'structured' ? settled.promptDeliveryResult : undefined)
  if (delivery && !(await delivery).delivered) {
    return false
  }

  if (result.surface.kind === 'local-terminal') {
    focusTerminalTabSurface(result.surface.tabId)
  }
  toast.success(copy.success)
  return true
}
