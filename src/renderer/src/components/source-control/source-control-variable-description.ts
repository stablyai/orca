import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SourceControlActionVariable } from '../../../../shared/source-control/ai/recipes/source-control-ai-action-variables'

export function sourceControlVariableDescription(
  variable: SourceControlActionVariable,
  t: Translate = translate
): string {
  switch (variable) {
    case 'basePrompt':
      return t(
        'sourceControl.variables.basePrompt',
        'Orca’s built-in prompt for this action, including the context Orca knows how to gather safely.'
      )
    case 'branch':
      return t('sourceControl.variables.branch', 'The current source-control branch name.')
    case 'stagedFiles':
      return t(
        'sourceControl.variables.stagedFiles',
        'A newline-separated list of staged files for commit-message generation.'
      )
    case 'stagedPatch':
      return t(
        'sourceControl.variables.stagedPatch',
        'The staged git patch used for commit-message generation.'
      )
    case 'baseBranch':
      return t(
        'sourceControl.variables.baseBranch',
        'The target branch selected in the Create PR composer.'
      )
    case 'currentTitle':
      return t(
        'sourceControl.variables.currentTitle',
        'The PR title currently typed in the composer before generation starts.'
      )
    case 'currentBody':
      return t(
        'sourceControl.variables.currentBody',
        'The PR description currently typed in the composer before generation starts.'
      )
    case 'commitSummary':
      return t(
        'sourceControl.variables.commitSummary',
        'A newline-separated list of commits on the branch compared to the base.'
      )
    case 'changedFiles':
      return t(
        'sourceControl.variables.changedFiles',
        'A summary of files changed between the branch and the base branch.'
      )
    case 'patch':
      return t(
        'sourceControl.variables.patch',
        'The branch diff against the base branch used for PR-details generation.'
      )
    case 'firstPrompt':
      return t(
        'sourceControl.variables.firstPrompt',
        'The first user request for this workspace or chat.'
      )
    case 'assistantMessage':
      return t(
        'sourceControl.variables.assistantMessage',
        'The initial agent response, when Orca has one available.'
      )
    case 'workspaces':
      return t(
        'sourceControl.variables.workspaces',
        'The numbered workspace names in this icon batch. Each reply SVG must start with <svg id="icon-N"> for its number.'
      )
    case 'linkedIssue':
      return t(
        'sourceControl.variables.linkedIssue',
        'The GitHub issue number linked to this workspace. Empty when no GitHub issue is linked (including GitLab-linked workspaces). Prefer instructional templates: a bare "Fixes #{linkedIssue}" becomes "Fixes #" when unlinked.'
      )
  }
}
