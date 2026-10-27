import type { GitHubPRStack } from '../../../../shared/github/pull-request-types'
import {
  getGitHubPRStackMergeBlocker as resolveGitHubPRStackMergeBlocker,
  getGitHubPRStackMergeScope as resolveGitHubPRStackMergeScope,
  type GitHubPRStackMergeScope as SharedGitHubPRStackMergeScope
} from '../../../../shared/github/pull-request-stack-merge'
import { translate } from '@/i18n/i18n'

export type GitHubPRStackMergeScope = SharedGitHubPRStackMergeScope & { label: string }

export function getGitHubPRStackMergeScope(
  stack: GitHubPRStack,
  currentPRNumber: number
): GitHubPRStackMergeScope {
  const scope = resolveGitHubPRStackMergeScope(stack)
  return {
    ...scope,
    label:
      scope.count === 1
        ? translate(
            'auto.components.right.sidebar.github.pr.stack.merge.55ae29b907',
            'Merge through #{{pr}} · {{count}} PR',
            { pr: currentPRNumber, count: scope.count }
          )
        : translate(
            'auto.components.right.sidebar.github.pr.stack.merge.b8446f6ec2',
            'Merge through #{{pr}} · {{count}} PRs',
            { pr: currentPRNumber, count: scope.count }
          )
  }
}

export function getGitHubPRStackMergeBlocker(scope: GitHubPRStackMergeScope): string | null {
  const blocker = resolveGitHubPRStackMergeBlocker(scope)
  if (!blocker) {
    return null
  }
  const pr = blocker.prNumber
  switch (blocker.reason) {
    case 'draft':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.189d0ec614',
        '#{{pr}} is still a draft.',
        { pr }
      )
    case 'closed':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.640fb50d9c',
        '#{{pr}} is closed.',
        { pr }
      )
    case 'conflicts':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.46ffcbda75',
        '#{{pr}} has merge conflicts.',
        { pr }
      )
    case 'changes_requested':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.6dabefd63e',
        '#{{pr}} has requested changes.',
        { pr }
      )
    case 'review_required':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.2bb21fc326',
        '#{{pr}} still needs review approval.',
        { pr }
      )
    case 'behind':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.c23faf74df',
        '#{{pr}} must be updated.',
        { pr }
      )
    case 'blocked':
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.f561e80968',
        '#{{pr}} is blocked.',
        { pr }
      )
  }
}
