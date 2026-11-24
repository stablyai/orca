import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { GiteaWorkItem, GiteaWorkItemFilter } from '../../../../../shared/gitea/gitea-types'
import type { GiteaTaskView } from './use-task-page-gitea-list'

export const getGiteaTaskViews = createLocalizedCatalog(
  (): { id: GiteaTaskView; label: string }[] => [
    { id: 'all', label: translate('auto.components.GiteaTaskList.bf66fad935', 'All') },
    { id: 'issues', label: translate('auto.components.GiteaTaskList.65a3bffe7a', 'Issues') },
    { id: 'prs', label: translate('auto.components.GiteaTaskList.9b21aab4c9', 'PRs') }
  ]
)

export const getGiteaTaskFilters = createLocalizedCatalog(
  (): { id: GiteaWorkItemFilter; label: string }[] => [
    { id: 'all', label: translate('auto.components.GiteaTaskList.c07dd13940', 'All open') },
    {
      id: 'assigned',
      label: translate('auto.components.GiteaTaskList.ab2a229e50', 'Assigned to me')
    },
    { id: 'created', label: translate('auto.components.GiteaTaskList.74f30cd767', 'Created') },
    { id: 'closed', label: translate('auto.components.GiteaTaskList.031c70d963', 'Closed') }
  ]
)

export function giteaItemStateLabel(item: GiteaWorkItem): string {
  if (item.type === 'pull' && item.state === 'merged') {
    return translate('auto.components.GiteaTaskList.9986e0e679', 'Merged')
  }
  if (item.type === 'pull' && item.draft) {
    return translate('auto.components.GiteaTaskList.747423c0f8', 'Draft')
  }
  return item.state === 'closed'
    ? translate('auto.components.GiteaTaskList.031c70d963', 'Closed')
    : translate('auto.components.GiteaTaskList.980519b0c8', 'Open')
}
