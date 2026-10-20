import { toast } from 'sonner'
import {
  launchPullRequestAgentPrompt,
  type PullRequestAgentPromptLaunchMessages
} from '@/lib/pull-request-agent-prompt-launch'
import {
  MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH,
  renderPullRequestCustomActionPrompt,
  type SourceControlCustomAction
} from '../../../../../shared/source-control-custom-actions'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

const CUSTOM_ACTION_LAUNCH_MESSAGES: PullRequestAgentPromptLaunchMessages = {
  savedAgentUnavailable: () =>
    translate(
      'pullRequestCustomActions.launch.agentUnavailable',
      'The agent chosen for this custom action is not available on this workspace host.'
    ),
  workspaceMissing: () =>
    translate(
      'pullRequestCustomActions.launch.workspaceMissing',
      'Unable to find the workspace attached to this pull request.'
    ),
  workspaceRevealFailed: () =>
    translate(
      'pullRequestCustomActions.launch.workspaceRevealFailed',
      'Unable to open the workspace attached to this pull request.'
    ),
  noWorkspace: () =>
    translate(
      'pullRequestCustomActions.launch.noWorkspace',
      'Unable to find a workspace for this pull request.'
    )
}

export async function runPullRequestCustomAction(args: {
  action: SourceControlCustomAction
  item: GitHubWorkItem
  repoId: string | null
  /** Opens the regular new-workspace flow when Orca cannot create the workspace on its own. */
  openWorkspaceComposer: () => void
}): Promise<boolean> {
  if (!args.repoId) {
    toast.error(CUSTOM_ACTION_LAUNCH_MESSAGES.noWorkspace())
    return false
  }
  const commandInput = renderPullRequestCustomActionPrompt(args.action, args.item)
  if (commandInput.length > MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH) {
    toast.error(
      translate(
        'pullRequestCustomActions.launch.promptTooLong',
        'The prompt for "{{value0}}" is too long once filled in. Shorten it in Git & Source Control settings.',
        { value0: args.action.label }
      )
    )
    return false
  }
  if (!commandInput) {
    toast.error(
      translate(
        'pullRequestCustomActions.launch.emptyPrompt',
        'The prompt for "{{value0}}" is empty. Update it in Git & Source Control settings.',
        { value0: args.action.label }
      )
    )
    return false
  }
  return await launchPullRequestAgentPrompt({
    repoId: args.repoId,
    item: { ...args.item, repoId: args.repoId },
    commandInput,
    savedAgentId: args.action.agentId ?? null,
    agentArgs: args.action.agentArgs,
    launchSource: 'task_page',
    telemetrySource: 'sidebar',
    messages: CUSTOM_ACTION_LAUNCH_MESSAGES,
    openModalFallback: () => {
      // Why: leaving the PR page is the user's call, so the composer opens only from the toast.
      toast.error(
        translate(
          'pullRequestCustomActions.launch.needsWorkspaceSetup',
          'Orca could not create the workspace for "{{value0}}" on its own. Create it, then run the action again.',
          { value0: args.action.label }
        ),
        {
          action: {
            label: translate('pullRequestCustomActions.launch.createWorkspace', 'Create workspace'),
            onClick: args.openWorkspaceComposer
          }
        }
      )
    }
  })
}
