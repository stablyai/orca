import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Row } from './worktree-list/grouping/row-types'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import {
  folderWorkspaceRow,
  header,
  item,
  repo,
  repoHeader,
  rowKey
} from './host-section-row-fixtures'

const TWO_RUNTIME_HOSTS: readonly HostSectionOption[] = [
  {
    id: 'runtime:devbox',
    kind: 'runtime',
    label: 'devbox',
    detail: 'Orca server',
    health: 'available'
  },
  {
    id: 'runtime:mac-mini',
    kind: 'runtime',
    label: 'Mac mini',
    detail: 'Orca server',
    health: 'available'
  }
]

// Why: placement must agree with the visibility filter's executionHostId
// resolution, or a stamped remote project group renders under whichever
// Orca server happens to be focused.
describe('addHostSectionRows stamped host attribution', () => {
  it('places a runtime-stamped folder workspace under its stamped host, not the focused host', () => {
    const macOwned: Repo = { ...repo('mac-project'), executionHostId: 'runtime:mac-mini' }
    const rows: Row[] = [
      repoHeader(macOwned),
      item('mac-wt', macOwned),
      folderWorkspaceRow(null, 'runtime:devbox')
    ]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: TWO_RUNTIME_HOSTS,
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:mac-mini'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:runtime:devbox',
      'folder-workspace:folder-1',
      'host:runtime:mac-mini',
      'repo:mac-project',
      'mac-wt'
    ])
  })

  it('lets a folder workspace stamp override a conflicting project-group host', () => {
    const macOwned: Repo = { ...repo('mac-project'), executionHostId: 'runtime:mac-mini' }
    const rows: Row[] = [
      repoHeader(macOwned),
      item('mac-wt', macOwned),
      folderWorkspaceRow(null, 'runtime:mac-mini', 'runtime:devbox')
    ]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: TWO_RUNTIME_HOSTS,
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:mac-mini'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:runtime:devbox',
      'folder-workspace:folder-1',
      'host:runtime:mac-mini',
      'repo:mac-project',
      'mac-wt'
    ])
  })

  it('attributes a repo-less project-group header to its stamped host instead of buffering it', () => {
    const macOwned: Repo = { ...repo('mac-project'), executionHostId: 'runtime:mac-mini' }
    const folderRow = folderWorkspaceRow(null, 'runtime:devbox')
    const groupHeader: Extract<Row, { type: 'header' }> = {
      ...header('project-group:group-1', 'Remote folder'),
      projectGroup: folderRow.projectGroup
    }
    const rows: Row[] = [groupHeader, folderRow, repoHeader(macOwned), item('mac-wt', macOwned)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: TWO_RUNTIME_HOSTS,
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:mac-mini'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:runtime:devbox',
      'project-group:group-1',
      'folder-workspace:folder-1',
      'host:runtime:mac-mini',
      'repo:mac-project',
      'mac-wt'
    ])
  })
})
