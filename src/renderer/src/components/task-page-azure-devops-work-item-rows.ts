import { translate } from '@/i18n/i18n'
import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import type { BacklogRow } from './task-page-azure-devops-backlog-tree'
import { STATE_FIELD, TITLE_FIELD } from './task-page-azure-devops-backlog-columns'

const CHANGED_DATE_FIELD = 'System.ChangedDate'
const AREA_PATH_FIELD = 'System.AreaPath'

/**
 * The Work items view has no backlog level, so no process column options apply.
 * Area path earns its place here: the view's whole point is items outside the
 * selected team's areas, and Changed date is the order the query returned.
 */
export function azureDevOpsWorkItemColumns(): AzureDevOpsBacklogColumnField[] {
  return [
    {
      referenceName: TITLE_FIELD,
      name: translate('auto.components.TaskPage.azureDevOps.columnTitle', 'Title'),
      width: 400
    },
    {
      referenceName: STATE_FIELD,
      name: translate('auto.components.TaskPage.azureDevOps.columnState', 'State'),
      width: 100
    },
    {
      referenceName: AREA_PATH_FIELD,
      name: translate('auto.components.TaskPage.azureDevOps.columnAreaPath', 'Area Path'),
      width: 200
    },
    {
      referenceName: CHANGED_DATE_FIELD,
      name: translate('auto.components.TaskPage.azureDevOps.columnChangedDate', 'Changed Date'),
      width: 120
    }
  ]
}

/** Flat rows, as Azure DevOps' own Work items view is; the backlog owns the tree. */
export function buildAzureDevOpsWorkItemRows(items: readonly AzureDevOpsWorkItem[]): BacklogRow[] {
  return items.map((item) => ({
    key: `item:${item.id}`,
    kind: 'item',
    item,
    depth: 0,
    hasChildren: false,
    expanded: false
  }))
}
