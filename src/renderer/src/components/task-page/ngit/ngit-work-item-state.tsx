import { CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest } from 'lucide-react'
import type {
  NgitWorkItem,
  NgitWorkItemState
} from '../../../../../shared/ngit/ngit-work-item-types'
import { translate } from '@/i18n/i18n'

export function ngitStateLabel(item: Pick<NgitWorkItem, 'type' | 'state'>): string {
  const labels: Record<NgitWorkItemState, string> = {
    open: translate('components.taskPage.ngit.stateOpen', 'Open'),
    draft: translate('components.taskPage.ngit.stateDraft', 'Draft'),
    merged: translate('components.taskPage.ngit.stateMerged', 'Merged'),
    closed: translate('components.taskPage.ngit.stateClosed', 'Closed')
  }
  return labels[item.state]
}

export function ngitTypeLabel(item: Pick<NgitWorkItem, 'type' | 'isPatch'>): string {
  if (item.type === 'issue') {
    return translate('components.taskPage.ngit.typeIssue', 'Issue')
  }
  return item.isPatch
    ? translate('components.taskPage.ngit.typePatch', 'Patch')
    : translate('components.taskPage.ngit.typePr', 'PR')
}

export function NgitStateIcon({
  item,
  className
}: {
  item: Pick<NgitWorkItem, 'type' | 'state'>
  className?: string
}): React.JSX.Element {
  if (item.state === 'merged') {
    return <GitMerge className={className} />
  }
  if (item.state === 'closed') {
    return item.type === 'issue' ? (
      <CircleCheck className={className} />
    ) : (
      <CircleSlash className={className} />
    )
  }
  return item.type === 'pr' ? (
    <GitPullRequest className={className} />
  ) : (
    <CircleDot className={className} />
  )
}
