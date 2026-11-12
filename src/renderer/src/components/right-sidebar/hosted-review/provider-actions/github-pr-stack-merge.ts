import type { GitHubPRStack } from '../../../../../../shared/github/pull-request-types'
import {
  getGitHubPRStackMergeBlocker as resolveGitHubPRStackMergeBlocker,
  getGitHubPRStackMergeScope as resolveGitHubPRStackMergeScope,
  type GitHubPRStackMergeScope as SharedGitHubPRStackMergeScope
} from '../../../../../../shared/github/pull-request-stack-merge'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type GitHubPRStackMergeScope = SharedGitHubPRStackMergeScope & { label: string }

export function getGitHubPRStackMergeScope(
  stack: GitHubPRStack,
  currentPRNumber: number,
  t: Translate = translate
): GitHubPRStackMergeScope {
  const scope = resolveGitHubPRStackMergeScope(stack)
  return {
    ...scope,
    label: t(
      'auto.components.right.sidebar.github.pr.stack.merge.mergeThroughLabel',
      'Merge through #{{pr}} · {{count}} PRs',
      {
        pr: currentPRNumber,
        count: scope.count,
        defaultValue_one: 'Merge through #{{pr}} · {{count}} PR'
      }
    )
  }
}

export function getGitHubPRStackMergeBlocker(
  scope: GitHubPRStackMergeScope,
  t: Translate = translate
): string | null {
  const blocker = resolveGitHubPRStackMergeBlocker(scope)
  if (!blocker) {
    return null
  }
  const pr = blocker.prNumber
  switch (blocker.reason) {
    case 'draft':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.189d0ec614',
        '#{{pr}} is still a draft.',
        { pr }
      )
    case 'closed':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.640fb50d9c',
        '#{{pr}} is closed.',
        { pr }
      )
    case 'conflicts':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.46ffcbda75',
        '#{{pr}} has merge conflicts.',
        { pr }
      )
    case 'changes_requested':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.6dabefd63e',
        '#{{pr}} has requested changes.',
        { pr }
      )
    case 'review_required':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.2bb21fc326',
        '#{{pr}} still needs review approval.',
        { pr }
      )
    case 'behind':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.c23faf74df',
        '#{{pr}} must be updated.',
        { pr }
      )
    case 'blocked':
      return t(
        'auto.components.right.sidebar.github.pr.stack.merge.f561e80968',
        '#{{pr}} is blocked.',
        { pr }
      )
  }
}
