import { translate } from '@/i18n/i18n'
import type { PrimaryAction } from './source-control-primary-action-types'

export function resolveLinkedReviewPrimaryAction(args: {
  hasOpenHostedReview: boolean
  canPushLinkedReviewWithoutUpstream: boolean
}): PrimaryAction | null {
  if (!args.hasOpenHostedReview) {
    return null
  }
  if (args.canPushLinkedReviewWithoutUpstream) {
    return {
      kind: 'push',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.95550cff15',
        'Push'
      ),
      // Why: older fork-review worktrees can lose persisted pushTarget and
      // appear untracked even though their branch config still names a PR head.
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.1d47e850cf',
        'Push updates to the linked review branch'
      ),
      disabled: false
    }
  }
  return {
    kind: 'commit',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
      'Commit'
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.primary.action.c39d0c75c3',
      'Linked review branch target is unavailable.'
    ),
    disabled: true
  }
}
