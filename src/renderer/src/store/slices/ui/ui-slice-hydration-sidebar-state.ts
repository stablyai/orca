import type { PersistedState } from '../../../../../shared/persisted-state-types'
import { normalizeRightSidebarRoute } from '../../right-sidebar-route'
import type { UISlice } from './ui-slice-contract'

export function normalizeHydratedSidebarState(ui: PersistedState['ui']): {
  rightSidebarRoute: ReturnType<typeof normalizeRightSidebarRoute>
  groupBy: UISlice['groupBy']
  groupBySecondary: UISlice['groupBySecondary']
} {
  const persistedGroupBy: string = ui.groupBy
  const groupBy: UISlice['groupBy'] = persistedGroupBy === 'parent' ? 'repo' : ui.groupBy
  const groupBySecondary: UISlice['groupBySecondary'] =
    ui.groupBySecondary !== groupBy &&
    (ui.groupBySecondary === 'workspace-status' ||
      ui.groupBySecondary === 'repo' ||
      ui.groupBySecondary === 'pr-status')
      ? ui.groupBySecondary
      : 'none'
  return {
    rightSidebarRoute: normalizeRightSidebarRoute(ui.rightSidebarTab, ui.rightSidebarExplorerView),
    groupBy,
    groupBySecondary
  }
}
