import { toast } from 'sonner'
import {
  launchPullRequestAgentPrompt,
  type PullRequestAgentPromptLaunchMessages
} from '@/lib/pull-request-agent-prompt-launch'
import { readSourceControlLaunchRecipeAgentId } from '../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control-ai-actions'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'

type StartFixChecksAgentArgs = {
  repoId: string
  basePrompt: string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  openModalFallback?: () => void
}

const FIX_CHECKS_LAUNCH_MESSAGES: PullRequestAgentPromptLaunchMessages = {
  savedAgentUnavailable: () =>
    translate(
      'auto.lib.fix.checks.agent.launch.4c7f783a7a',
      'Saved checks agent is not available on this workspace host.'
    ),
  workspaceMissing: () =>
    translate(
      'auto.lib.fix.checks.agent.launch.dfb4dd7c00',
      'Unable to find the workspace attached to these checks.'
    ),
  workspaceRevealFailed: () =>
    translate(
      'auto.lib.fix.checks.agent.launch.03c1d61f83',
      'Unable to open the workspace attached to these checks.'
    ),
  noWorkspace: () =>
    translate(
      'auto.lib.fix.checks.agent.launch.027228a06b',
      'Unable to find a workspace for these checks.'
    )
}

export async function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
  const recipe = resolveSourceControlActionRecipe({
    settings: store.settings,
    repo,
    actionId: 'fixChecks'
  })
  const commandInput = renderSourceControlActionCommandTemplate(
    recipe.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
    { basePrompt: args.basePrompt }
  ).trim()
  if (!commandInput) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.9f00d7df0c',
        'Fix checks prompt is empty. Update Source Control AI settings.'
      )
    )
    return false
  }

  return await launchPullRequestAgentPrompt({
    ...args,
    commandInput,
    savedAgentId: readSourceControlLaunchRecipeAgentId(recipe),
    agentArgs: recipe.agentArgs,
    messages: FIX_CHECKS_LAUNCH_MESSAGES
  })
}
