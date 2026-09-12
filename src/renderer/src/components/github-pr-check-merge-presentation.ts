import type { CheckStatus } from '../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

type GitHubPRCheckMergePresentation = {
  label: string
  tone: string
  tooltip: string
}

export function getGitHubPRCheckMergePresentation(
  state: CheckStatus | 'action_required' | 'none' | undefined,
  dangerTone: string,
  warningTone: string
): GitHubPRCheckMergePresentation | null {
  if (state === 'failure') {
    return {
      label: translate('auto.components.github.pr.merge.state.87fa36ac83', 'Checks failed'),
      tone: dangerTone,
      tooltip: translate(
        'auto.components.github.pr.merge.state.1432ecff30',
        'GitHub says this PR can merge, but some checks failed'
      )
    }
  }
  if (state === 'action_required') {
    return {
      label: translate(
        'auto.components.editor.CheckRunDetailsPanel.actionRequired',
        'Action required'
      ),
      tone: warningTone,
      tooltip: translate(
        'auto.components.right.sidebar.checks.panel.content.actionRequiredHint',
        'Needs a manual action on GitHub (e.g. approving the run) to unblock merging.'
      )
    }
  }
  if (state === 'pending') {
    return {
      label: translate('auto.components.github.pr.merge.state.4e2507176b', 'Checks pending'),
      tone: warningTone,
      tooltip: translate(
        'auto.components.github.pr.merge.state.9bd983ce8f',
        'GitHub says this PR can merge, but checks are still running'
      )
    }
  }
  return null
}
