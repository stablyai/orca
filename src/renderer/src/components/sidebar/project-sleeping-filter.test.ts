import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import { makeRepo, makeWorktree, makeTerminalTab } from '../worktree-jump-palette-test-fixtures'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

const repoMap = new Map([['repo-1', makeRepo()]])

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

describe('project sleeping filter', () => {
  const sleeping = makeWorktree('sleeping', 'Sleeping')
  const awake = makeWorktree('awake', 'Awake')
  const other = makeWorktree('other', 'Other', { repoId: 'repo2' })
  const remote = { ...makeWorktree('remote', 'Remote'), hostId: 'ssh:box' as const }
  const folder = { ...makeWorktree('folder', 'Folder'), isMainWorktree: true, branch: '', head: '' }
  const worktrees = [sleeping, awake, other, remote, folder]
  const options = () =>
    visibleOptions({
      hideSleepingProjectKeys: ['local\0repo-1'],
      tabsByWorktree: { awake: [makeTerminalTab('tab', 'awake', 'Terminal')] },
      ptyIdsByTabId: { tab: ['pty'] }
    })
  const visible = (opts: VisibleOptions) =>
    computeVisibleWorktreeIds(
      { repo1: worktrees },
      worktrees.map((w) => w.id),
      opts
    )

  it('hides only sleeping rows in the selected host and project, retaining folder entry points', () => {
    expect(visible(options())).toEqual(['awake', 'other', 'remote', 'folder'])
  })
  it('keeps project identity stable when a different runtime is focused', () => {
    expect(visible({ ...options(), defaultHostId: 'runtime:other' })).toEqual([
      'awake',
      'other',
      'remote',
      'folder'
    ])
  })

  it('restores sleeping rows when the project toggle is cleared', () => {
    expect(visible({ ...options(), hideSleepingProjectKeys: [] })).toEqual(
      worktrees.map((w) => w.id)
    )
  })
  it('keeps the global sleeping filter in force when the project toggle is cleared', () => {
    expect(
      visible({ ...options(), hideSleepingProjectKeys: [], showSleepingWorkspaces: false })
    ).toEqual(['awake', 'folder'])
  })
  it('honors the existing primary-workspace exemption opt-out', () => {
    expect(visible({ ...options(), alwaysShowDefaultBranchWorkspace: false })).toEqual([
      'awake',
      'other',
      'remote'
    ])
  })
  it('keeps browser and agent activity visible without a terminal', () => {
    expect(
      visible({ ...options(), browserTabsByWorktree: { sleeping: [{ id: 'browser' }] } })
    ).toContain('sleeping')
    expect(visible({ ...options(), worktreeIdsWithLiveAgent: new Set(['sleeping']) })).toContain(
      'sleeping'
    )
  })
})
