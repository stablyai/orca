import { translate } from '@/i18n/i18n'
import type { PrimaryAction } from './source-control-primary-action-types'
import type { PRState } from '../../../../shared/types'

export function resolveUnpublishedPrimaryAction({
  hasCurrentBranch,
  isPRStateLoading,
  prState
}: {
  hasCurrentBranch: boolean
  isPRStateLoading?: boolean
  prState?: PRState | null
}): PrimaryAction {
  if (!hasCurrentBranch) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.e61b0d7a3c',
        'Check out a branch before publishing commits.'
      ),
      disabled: true
    }
  }

  if (isPRStateLoading) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.41d4bcf157',
        'Checking PR status…'
      ),
      disabled: true
    }
  }

  if (prState === 'merged') {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.3d5dccef0b',
        'Nothing to commit. PR is already merged.'
      ),
      disabled: true
    }
  }

  return {
    kind: 'publish',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.7b4d02e6b8',
      'Publish Branch'
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.primary.action.1884cf34af',
      'Publish this branch to origin'
    ),
    disabled: false
  }
}
