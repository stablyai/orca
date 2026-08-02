import { toast } from 'sonner'
import type { AppState } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getConnectionId } from '@/lib/connection-context'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '@/lib/source-control-launch-agent-selection'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import { buildSourceControlRecoveryAgentCommandInput } from '../../../../shared/source-control-recovery-agent-command'
import { translate } from '@/i18n/i18n'

type SourceControlAiLaunchStoreSnapshot = Pick<
  AppState,
  'settings' | 'ensureDetectedAgents' | 'ensureRemoteDetectedAgents'
>

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
  activeSourceControlLaunchPlatform: NodeJS.Platform
  sourceRepoConnectionId?: string | null
  actionId: SourceControlLaunchActionId
  basePrompt: string | null
  promptOverride?: string
  getLaunchActionRecipe: (actionId: SourceControlLaunchActionId) => SourceControlActionRecipe
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

  const store = getStoreState()
  const savedRecipe = getLaunchActionRecipe(actionId)
  const agentArgsPlan = planAgentCliArgsSuffix(
    savedRecipe.agentArgs,
    activeSourceControlLaunchPlatform === 'win32' ? 'powershell' : 'posix'
  )
  if (!agentArgsPlan.ok) {
    // Why: saved launch recipes are shared with direct launches; reject bad
    // argv before remote agent detection or terminal creation has side effects.
    toast.error(agentArgsPlan.error)
    return false
  }
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

  const detectedAgents =
    typeof connectionId === 'string'
      ? await store.ensureRemoteDetectedAgents(connectionId)
      : await store.ensureDetectedAgents()
  const savedAgent = readSourceControlLaunchRecipeAgentId(savedRecipe)
  if (
    savedAgent &&
    (!detectedAgents.includes(savedAgent) ||
      !isTuiAgentEnabled(savedAgent, store.settings?.disabledTuiAgents))
  ) {
    toast.error(copy.savedAgentUnavailable)
    return false
  }
  const agent = pickSourceControlLaunchAgent({
    savedAgent,
    defaultAgent: store.settings?.defaultTuiAgent,
    detectedAgents,
    disabledAgents: store.settings?.disabledTuiAgents
  })
  if (!agent) {
    toast.error(copy.noEnabledAgent)
    return false
  }
  const result = launchAgentInNewTab({
    agent,
    worktreeId: activeWorktreeId,
    groupId: activeGroupId ?? activeWorktreeId,
    prompt,
    agentArgs: savedRecipe.agentArgs,
    promptDelivery: 'submit-after-ready',
    launchPlatform: activeSourceControlLaunchPlatform,
    launchSource: 'source_control_recovery'
  })
  if (!result) {
    toast.error(copy.launchCommandUnavailable)
    return false
  }

  if (result.tabId) {
    focusTerminalTabSurface(result.tabId)
  }
  toast.success(copy.success)
  return true
}
