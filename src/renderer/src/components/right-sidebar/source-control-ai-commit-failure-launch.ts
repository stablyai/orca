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
import { buildCommitFailureAgentCommandInput } from './source-control-ai-prompts'

type SourceControlAiLaunchStoreSnapshot = Pick<
  AppState,
  'settings' | 'ensureDetectedAgents' | 'ensureRemoteDetectedAgents'
>

export async function launchCommitFailureAgentWithDefault({
  activeWorktreeId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  sourceRepoConnectionId,
  commitFailureRecoveryPrompt,
  promptOverride,
  getLaunchActionRecipe,
  getStoreState
}: {
  activeWorktreeId: string
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform
  sourceRepoConnectionId?: string | null
  commitFailureRecoveryPrompt: string | null
  promptOverride?: string
  getLaunchActionRecipe: (actionId: SourceControlLaunchActionId) => SourceControlActionRecipe
  getStoreState: () => SourceControlAiLaunchStoreSnapshot
}): Promise<boolean> {
  const connectionId = getConnectionId(activeWorktreeId) ?? sourceRepoConnectionId ?? null
  if (connectionId === undefined) {
    toast.error('Unable to resolve the workspace connection.')
    return false
  }

  const store = getStoreState()
  const savedRecipe = getLaunchActionRecipe('fixCommitFailure')
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
  if (!commitFailureRecoveryPrompt) {
    toast.error('Could not build the agent prompt.')
    return false
  }
  const prompt = buildCommitFailureAgentCommandInput({
    promptOverride,
    commandInputTemplate: savedRecipe.commandInputTemplate,
    basePrompt: commitFailureRecoveryPrompt
  })
  if (!prompt) {
    toast.error('Commit failure prompt is empty. Update Source Control AI settings.')
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
    toast.error('Saved AI agent is unavailable. Use Customize launch to choose another agent.')
    return false
  }
  const agent = pickSourceControlLaunchAgent({
    savedAgent,
    defaultAgent: store.settings?.defaultTuiAgent,
    detectedAgents,
    disabledAgents: store.settings?.disabledTuiAgents
  })
  if (!agent) {
    toast.error('No enabled AI agents. Configure agents in Settings.')
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
    toast.error('Could not build the agent launch command.')
    return false
  }

  if (result.tabId) {
    focusTerminalTabSurface(result.tabId)
  }
  toast.success('Started an AI agent for the commit failure.')
  return true
}
