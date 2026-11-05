export { resolveChecksActionAgent } from '@/lib/source-control-agent-picker'
import { toast } from 'sonner'
import {
  launchPullRequestAgentPrompt,
  type PullRequestAgentPromptLaunchMessages
} from '@/lib/pull-request-agent-prompt-launch'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control/ai/source-control-ai-operation-policy'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control/ai/recipes/source-control-ai-actions'
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
  onSetupRequired?: () => void
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

export function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const { basePrompt, ...launchArgs } = args
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
  const recipe = structuredClone(
    resolveSourceControlActionRecipe({
      settings: store.settings,
      repo,
      actionId: 'fixChecks'
    })
  )
  const renderPrompt = (): string => {
    const prompt = renderSourceControlActionCommandTemplate(
      recipe.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
      { basePrompt }
    ).trim()
    if (!prompt) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.9f00d7df0c',
          'Fix checks prompt is empty. Update Source Control AI settings.'
        )
      )
    }
    return prompt
  }
  return launchPullRequestAgentPrompt({
    ...launchArgs,
    recipe,
    renderPrompt,
    messages: FIX_CHECKS_LAUNCH_MESSAGES
  })
}
