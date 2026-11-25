import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { RenderRow } from '../listing/render-row'

/** Height of one text line under a group header's title. */
export const GROUP_HEADER_DETAIL_LINE_HEIGHT = 16

/** Lines a header shows under its title: a local group bound to a Claude account shows that
 *  account's usage. Headers are fixed-size, so the row estimate and the render both read this. */
export function groupHeaderDetailLines(row: RenderRow | undefined): number {
  return claudeBoundGroupId(row) ? 1 : 0
}

/** The header's group when it is local and bound to a Claude account. */
export function claudeBoundGroupId(row: RenderRow | undefined): string | undefined {
  const group = row?.type === 'header' && !row.repo ? row.projectGroup : undefined
  return group?.id &&
    'claudeAccount' in group &&
    group.claudeAccount &&
    getRepoExecutionHostId(group) === 'local'
    ? group.id
    : undefined
}
