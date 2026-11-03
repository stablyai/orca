import { translate } from '@/i18n/i18n'
import type { SourceControlActionVariable } from '../../../../shared/source-control-ai-action-variables'

export function sourceControlVariableDescription(variable: SourceControlActionVariable): string {
  switch (variable) {
    case 'basePrompt':
      return translate(
        'sourceControl.variables.basePrompt',
        'Orca’s built-in prompt for this action, including the context Orca knows how to gather safely.'
      )
    case 'branch':
      return translate('sourceControl.variables.branch', 'The current source-control branch name.')
    case 'stagedFiles':
      return translate(
        'sourceControl.variables.stagedFiles',
        'A newline-separated list of staged files for commit-message generation.'
      )
    case 'stagedPatch':
      return translate(
        'sourceControl.variables.stagedPatch',
        'The staged git patch used for commit-message generation.'
      )
    case 'baseBranch':
      return translate(
        'sourceControl.variables.baseBranch',
        'The target branch selected in the Create PR composer.'
      )
    case 'currentTitle':
      return translate(
        'sourceControl.variables.currentTitle',
        'The PR title currently typed in the composer before generation starts.'
      )
    case 'currentBody':
      return translate(
        'sourceControl.variables.currentBody',
        'The PR description currently typed in the composer before generation starts.'
      )
    case 'commitSummary':
      return translate(
        'sourceControl.variables.commitSummary',
        'A newline-separated list of commits on the branch compared to the base.'
      )
    case 'changedFiles':
      return translate(
        'sourceControl.variables.changedFiles',
        'A summary of files changed between the branch and the base branch.'
      )
    case 'patch':
      return translate(
        'sourceControl.variables.patch',
        'The branch diff against the base branch used for PR-details generation.'
      )
    case 'firstPrompt':
      return translate(
        'sourceControl.variables.firstPrompt',
        'The first user request for this workspace or chat.'
      )
    case 'assistantMessage':
      return translate(
        'sourceControl.variables.assistantMessage',
        'The initial agent response, when Orca has one available.'
      )
    case 'linkedIssue':
      return translate(
        'sourceControl.variables.linkedIssue',
        'The GitHub issue number linked to this workspace. Empty when no GitHub issue is linked (including GitLab-linked workspaces). Prefer instructional templates: a bare "Fixes #{linkedIssue}" becomes "Fixes #" when unlinked.'
      )
  }
}
