import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getAttentionOrderWorkspaceTargets,
  setPublishedSidebarWorktrees
} from './attention-order-workspaces'
import { setVisibleWorktreeIds, setVisibleWorktreeShortcutTargets } from './visible-worktrees'

const initialState = useAppStore.getInitialState()

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture fills only the fields ordering reads.
  return {
    id,
    repoId: 'repo1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

function makeRepo(id: string): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture fills only the fields ordering reads.
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    defaultBranch: 'main',
    connectionId: null
  } as unknown as Repo
}

function makeProjectGroup(id: string): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/tmp/${id}`,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(id: string, projectGroupId: string): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/tmp/${id}`,
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function seedStore(worktrees: Worktree[], overrides: Partial<AppState> = {}): void {
  useAppStore.setState(
    {
      ...initialState,
      repos: [makeRepo('repo1'), makeRepo('repo2')],
      worktreesByRepo: {
        repo1: worktrees.filter((w) => w.repoId === 'repo1'),
        repo2: worktrees.filter((w) => w.repoId === 'repo2')
      },
      // Why: fixtures have no PTYs, so the sleeping filter would drop every workspace.
      showSleepingWorkspaces: true,
      groupBy: 'repo',
      sortBy: 'manual',
      ...overrides
    },
    true
  )
}

const ids = (): string[] => getAttentionOrderWorkspaceTargets().map((target) => target.id)

describe('next-attention workspace order', () => {
  afterEach(() => {
    setPublishedSidebarWorktrees(null)
    setVisibleWorktreeIds(null)
    setVisibleWorktreeShortcutTargets(null)
    useAppStore.setState(initialState, true)
  })

  it('keeps members of a collapsed group that Cmd+1-9 elides', () => {
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const feature = makeWorktree('wt-feature')
    seedStore([main, feature], { collapsedGroups: new Set(['project:repo:repo1']) })

    expect(ids()).toEqual(['wt-main', 'wt-feature'])
  })

  it('puts a pinned workspace at its Pinned slot even when pins also show in groups', () => {
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const pinned = makeWorktree('wt-pinned', { isPinned: true })

    for (const showPinnedWorktreesInGroups of [false, true]) {
      seedStore([main, pinned], {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ordering reads only this setting.
        settings: { showPinnedWorktreesInGroups } as AppState['settings']
      })

      expect(ids()).toEqual(['wt-pinned', 'wt-main'])
    }
  })

  it('includes folder workspaces', () => {
    const group = makeProjectGroup('group-1')
    const folderWorkspace = makeFolderWorkspace('fw-1', group.id)
    seedStore([makeWorktree('wt-main', { isMainWorktree: true })], {
      projectGroups: [group],
      folderWorkspaces: [folderWorkspace]
    })

    expect(ids()).toContain(folderWorkspaceKey(folderWorkspace.id))
  })

  it('skips folder workspaces another device created while those are hidden', () => {
    const group = makeProjectGroup('group-1')
    const mine = makeFolderWorkspace('fw-mine', group.id)
    const theirs: FolderWorkspace = {
      ...makeFolderWorkspace('fw-theirs', group.id),
      creatorProvenance: { kind: 'paired-device', deviceId: 'phone' }
    }
    seedStore([makeWorktree('wt-main', { isMainWorktree: true })], {
      projectGroups: [group],
      folderWorkspaces: [mine, theirs],
      hideWorkspacesFromOtherDevices: true
    })

    expect(ids()).toContain(folderWorkspaceKey(mine.id))
    expect(ids()).not.toContain(folderWorkspaceKey(theirs.id))
  })

  it('keys a legacy SSH row by its resolved host but activates it without one', () => {
    seedStore([makeWorktree('wt-remote')], {
      repos: [{ ...makeRepo('repo1'), connectionId: 'box' }, makeRepo('repo2')]
    })

    const [target] = getAttentionOrderWorkspaceTargets()

    expect(target.id).toBe('wt-remote')
    expect(target.identityHostId).not.toBe('local')
    expect(target.executionHostId).toBeUndefined()
  })

  it('pins a local row to the local host so a same-id remote row cannot take its activation', () => {
    seedStore([makeWorktree('wt-local')])

    expect(getAttentionOrderWorkspaceTargets()).toEqual([
      { id: 'wt-local', identityHostId: 'local', executionHostId: 'local' }
    ])
  })

  it('skips workspaces a sidebar filter hides', () => {
    const shown = makeWorktree('wt-shown')
    const hidden = makeWorktree('wt-hidden', { repoId: 'repo2' })
    seedStore([shown, hidden], { filterRepoIds: ['repo1'] })

    expect(ids()).toEqual(['wt-shown'])
  })

  it('orders by the list the sidebar last published rather than a live re-sort', () => {
    const first = makeWorktree('wt-first', { sortOrder: 2 })
    const second = makeWorktree('wt-second', { sortOrder: 1 })
    seedStore([first, second], { groupBy: 'none' })
    expect(ids()).toEqual(['wt-first', 'wt-second'])

    setPublishedSidebarWorktrees([second, first])

    expect(ids()).toEqual(['wt-second', 'wt-first'])
  })
})
