import { describe, expect, it } from 'vitest'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader,
  type WorkspaceRowFilters
} from './workspace-row-filters'

type Row = { id: string; folder?: boolean; facts?: Partial<Record<string, boolean>> }

const read: WorkspaceRowFactReader<Row> = {
  isArchived: () => false,
  isFolderWorkspace: (row) => row.folder === true,
  repoId: () => 'repo',
  hostId: () => 'local',
  isOtherClient: (row) => row.facts?.otherClient === true,
  isDefaultBranch: (row) => row.facts?.defaultBranch === true,
  isAutomationCreated: (row) => row.facts?.automation === true,
  isCliCreated: (row) => row.facts?.cli === true,
  isDetachedHead: (row) => row.facts?.detached === true,
  isMainWorktree: (row) => row.facts?.main === true,
  isSleeping: (row) => row.facts?.sleeping !== false
}

const everyFilterOn: WorkspaceRowFilters = {
  hideSleepingWorkspaces: true,
  alwaysShowDefaultBranchWorkspace: false,
  hideDefaultBranchWorkspace: true,
  hideAutomationGeneratedWorkspaces: true,
  hideCliCreatedWorkspaces: true,
  hideDetachedHeadWorkspaces: true,
  hideWorkspacesFromOtherDevices: true,
  filterRepoIds: ['other-repo'],
  visibleHostIds: ['local']
}

describe('filterWorkspaceRows', () => {
  it('keeps a folder workspace through every filter but the host and other-client ones', () => {
    expect(filterWorkspaceRows([{ id: 'f', folder: true }], everyFilterOn, read)).toHaveLength(1)
    expect(
      filterWorkspaceRows(
        [{ id: 'f', folder: true, facts: { otherClient: true } }],
        everyFilterOn,
        read
      )
    ).toHaveLength(0)
    expect(
      filterWorkspaceRows(
        [{ id: 'f', folder: true }],
        { ...everyFilterOn, visibleHostIds: [] },
        read
      )
    ).toHaveLength(0)
  })

  it('shows an awake row whose kind facts are missing', () => {
    const filters = { ...everyFilterOn, filterRepoIds: [] }
    expect(
      filterWorkspaceRows([{ id: 'r', facts: { sleeping: false } }], filters, read)
    ).toHaveLength(1)
  })
})
