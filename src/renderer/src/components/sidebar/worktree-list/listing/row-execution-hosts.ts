import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Row } from '../grouping/row-types'
import { resolveFolderRowHost } from './folder-row-identity'
import { getProjectGroupExecutionHostIdForRows } from './host-filtering'

export function resolveSidebarRowHosts(
  rows: readonly Row[],
  defaultHostId: ExecutionHostId
): Row[] {
  return rows.map((row) => {
    if (row.type === 'folder-workspace') {
      return resolveFolderRowHost(row, defaultHostId)
    }
    if (row.type !== 'header' || !row.projectGroup || row.projectGroup.id === null) {
      return row
    }
    const executionHostId = getProjectGroupExecutionHostIdForRows(row.projectGroup, defaultHostId)
    return row.projectGroup.executionHostId === executionHostId
      ? row
      : { ...row, projectGroup: { ...row.projectGroup, executionHostId } }
  })
}
