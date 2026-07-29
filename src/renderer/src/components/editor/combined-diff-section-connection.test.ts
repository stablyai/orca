import { afterEach, describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { getCombinedDiffSectionConnectionId } from './combined-diff-section-connection'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: '/home/neil/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function makeFolderWorkspace(folderPath: string): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Platform workspace',
    folderPath,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeGroup(parentPath: string): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('getCombinedDiffSectionConnectionId', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('routes a section to its SSH child repo in a mixed folder workspace (#6688)', () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace('/home/neil/platform')],
      projectGroups: [makeGroup('/home/neil/platform')],
      repos: [
        makeRepo({ id: 'repo-local', path: '/home/neil/platform/web', projectGroupId: 'group-1' }),
        makeRepo({
          id: 'repo-ssh',
          path: '/home/neil/platform/api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        })
      ],
      worktreesByRepo: {}
    })

    // Section paths are repo-tree-relative; joined onto the workspace root they
    // must resolve to the owning child repo, not the ambiguous workspace.
    expect(
      getCombinedDiffSectionConnectionId(workspaceKey, '/home/neil/platform', 'api/src/index.ts')
    ).toBe('ssh-1')
    // Local child repo -> no connection (local read).
    expect(
      getCombinedDiffSectionConnectionId(workspaceKey, '/home/neil/platform', 'web/src/index.ts')
    ).toBeUndefined()
    // A path owned by no single child repo stays ambiguous.
    expect(
      getCombinedDiffSectionConnectionId(workspaceKey, '/home/neil/platform', 'README.md')
    ).toBeUndefined()
  })

  it('composes Windows section paths with the workspace root separator', () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    // A mixed local+SSH workspace makes the whole-workspace owner ambiguous, so
    // resolution must fall through to composing the section path — the behavior
    // this test guards. A single-SSH workspace would resolve before joinPath.
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace('C:\\Users\\neil\\platform')],
      projectGroups: [makeGroup('C:\\Users\\neil\\platform')],
      repos: [
        makeRepo({
          id: 'repo-local',
          path: 'C:\\Users\\neil\\platform\\web',
          projectGroupId: 'group-1'
        }),
        makeRepo({
          id: 'repo-ssh',
          path: 'C:\\Users\\neil\\platform\\api',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        })
      ],
      worktreesByRepo: {}
    })

    expect(
      getCombinedDiffSectionConnectionId(
        workspaceKey,
        'C:\\Users\\neil\\platform',
        'api/src/index.ts'
      )
    ).toBe('ssh-1')
    expect(
      getCombinedDiffSectionConnectionId(
        workspaceKey,
        'C:\\Users\\neil\\platform',
        'web/src/index.ts'
      )
    ).toBeUndefined()
  })
})
