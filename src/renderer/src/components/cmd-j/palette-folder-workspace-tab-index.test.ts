import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  buildSearchableWorkspaceTabs,
  searchWorkspaceTabs
} from '@/lib/workspace-tab-palette-search'
import { sortWorktreesSmart } from '../sidebar/smart-sort'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import {
  collectFolderWorkspaceHostLabels,
  collectPaletteTabIndexWorkspaces,
  excludePaletteFolderWorkspaces
} from './palette-folder-workspace-tab-index'

const WORKSPACE_KEY = 'folder:fw-1'

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-tasks',
    name: 'Tasks',
    folderPath: '/tmp/tasks',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Palette Worktree',
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
  }
}

function makeUnifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'unified-terminal-1',
    entityId: 'terminal-1',
    groupId: 'group-1',
    worktreeId: WORKSPACE_KEY,
    contentType: 'terminal',
    label: 'ORCA-42 payment retries',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'terminal-1',
    ptyId: 'pty-1',
    worktreeId: WORKSPACE_KEY,
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: WORKSPACE_KEY,
    activeTabId: 'unified-terminal-1',
    tabOrder: ['unified-terminal-1'],
    ...overrides
  }
}

function buildEntries(
  workspaces: readonly Worktree[],
  overrides: Partial<Parameters<typeof buildSearchableWorkspaceTabs>[0]> = {}
) {
  return buildSearchableWorkspaceTabs({
    worktrees: workspaces,
    ownershipWorktrees: workspaces,
    repoMap: new Map(),
    worktreeOrder: new Map(
      workspaces.map((workspace, index) => [getWorktreeHostIdentity(workspace), index])
    ),
    unifiedTabsByWorktree: { [WORKSPACE_KEY]: [makeUnifiedTab()] },
    tabsByWorktree: { [WORKSPACE_KEY]: [makeTerminalTab()] },
    openFiles: [],
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    activeGroupIdByWorktree: {},
    groupsByWorktree: { [WORKSPACE_KEY]: [makeGroup()] },
    activeWorktreeId: null,
    activeTabType: 'terminal',
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    generatedTitlesEnabled: true,
    ...overrides
  })
}

const LOCAL_HOST: SidebarHostOption = {
  id: 'local',
  label: 'This computer',
  detail: '',
  kind: 'local',
  health: 'local',
  presence: 'local'
}

const SSH_HOST: SidebarHostOption = {
  id: 'ssh:remote-1',
  label: 'build-box',
  detail: '',
  kind: 'ssh',
  health: 'available',
  presence: 'configured'
}

describe('collectPaletteTabIndexWorkspaces', () => {
  it('adapts folder workspaces into the worktree shape the tab index walks', () => {
    const workspaces = collectPaletteTabIndexWorkspaces(
      [makeWorktree()],
      [makeFolderWorkspace({ connectionId: 'remote-1' })]
    )

    expect(workspaces.map((workspace) => workspace.id)).toEqual(['wt-1', WORKSPACE_KEY])
    expect(workspaces[1]?.displayName).toBe('Tasks')
    expect(workspaces[1]?.hostId).toBe('ssh:remote-1')
  })

  it('keeps folder-workspace ids out of the worktree id space', () => {
    // Why: palette rows key on the workspace id, so a collision would let one row
    // resolve — and activate — the other workspace.
    const workspaces = collectPaletteTabIndexWorkspaces(
      [makeWorktree({ id: 'fw-1' })],
      [makeFolderWorkspace()]
    )

    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(workspaces.length)
  })

  it('returns the same array when there is no folder workspace to exclude', () => {
    const worktrees = [makeWorktree()]
    expect(excludePaletteFolderWorkspaces(worktrees)).toBe(worktrees)
  })

  it('drops folder workspaces for the indexes that only understand worktrees', () => {
    const workspaces = collectPaletteTabIndexWorkspaces([makeWorktree()], [makeFolderWorkspace()])
    expect(excludePaletteFolderWorkspaces(workspaces).map((workspace) => workspace.id)).toEqual([
      'wt-1'
    ])
  })
})

describe('folder-workspace tabs in the Cmd+J tab index', () => {
  it('finds a folder-workspace tab by its title', () => {
    const workspaces = collectPaletteTabIndexWorkspaces([], [makeFolderWorkspace()])
    const results = searchWorkspaceTabs(buildEntries(workspaces), 'ORCA-42')

    expect(results.map((result) => result.worktreeId)).toEqual([WORKSPACE_KEY])
    expect(results[0]?.title).toBe('ORCA-42 payment retries')
    expect(results[0]?.worktreeName).toBe('Tasks')
  })

  it('stamps the SSH host so the row activates on the host it was indexed from', () => {
    const workspaces = collectPaletteTabIndexWorkspaces(
      [],
      [makeFolderWorkspace({ connectionId: 'remote-1' })]
    )
    const [result] = searchWorkspaceTabs(buildEntries(workspaces), '')

    expect(result?.executionHostId).toBe('ssh:remote-1')
  })

  it('keeps a remote folder workspace indexed while its host is unreachable', () => {
    // Why: losing contact with a host says nothing about the workspace existing —
    // dropping the rows would make the tabs unreachable exactly when they are needed.
    const workspaces = collectPaletteTabIndexWorkspaces(
      [],
      [makeFolderWorkspace({ connectionId: 'remote-1' })]
    )
    const results = searchWorkspaceTabs(buildEntries(workspaces), 'ORCA-42')

    expect(results).toHaveLength(1)
    expect(
      collectFolderWorkspaceHostLabels(
        [makeFolderWorkspace({ connectionId: 'remote-1' })],
        [LOCAL_HOST, { ...SSH_HOST, health: 'disconnected' }],
        true
      ).get(`ssh:remote-1|${WORKSPACE_KEY}`)
    ).toBe('build-box')
  })

  it('orders folder workspaces among worktrees instead of after them', () => {
    const worktree = makeWorktree({ sortOrder: 1 })
    const folderWorkspace = makeFolderWorkspace({ sortOrder: 2 })
    // Cold start (no live PTY) ranks by persisted sortOrder, so the folder workspace leads.
    const sorted = sortWorktreesSmart(
      collectPaletteTabIndexWorkspaces([worktree], [folderWorkspace]),
      {},
      new Map(),
      {},
      {},
      {}
    )

    expect(sorted.map((workspace) => workspace.id)).toEqual([WORKSPACE_KEY, 'wt-1'])

    const entries = buildEntries(sorted, {
      unifiedTabsByWorktree: {
        [WORKSPACE_KEY]: [makeUnifiedTab()],
        'wt-1': [
          makeUnifiedTab({
            id: 'unified-terminal-2',
            worktreeId: 'wt-1',
            label: 'ORCA-42 shell'
          })
        ]
      },
      tabsByWorktree: {
        [WORKSPACE_KEY]: [makeTerminalTab()],
        'wt-1': [makeTerminalTab({ worktreeId: 'wt-1' })]
      },
      groupsByWorktree: {
        [WORKSPACE_KEY]: [makeGroup()],
        'wt-1': [
          makeGroup({
            worktreeId: 'wt-1',
            activeTabId: 'unified-terminal-2',
            tabOrder: ['unified-terminal-2']
          })
        ]
      }
    })

    expect(searchWorkspaceTabs(entries, 'ORCA-42').map((result) => result.worktreeId)).toEqual([
      WORKSPACE_KEY,
      'wt-1'
    ])
  })
})

describe('collectFolderWorkspaceHostLabels', () => {
  it('labels a remote folder workspace by its own host stamp', () => {
    const labels = collectFolderWorkspaceHostLabels(
      [makeFolderWorkspace({ executionHostId: 'ssh:remote-1' })],
      [LOCAL_HOST, SSH_HOST],
      false
    )

    expect(labels.get(`ssh:remote-1|${WORKSPACE_KEY}`)).toBe('build-box')
  })

  it('leaves local folder workspaces unlabelled when no remote host is live', () => {
    const labels = collectFolderWorkspaceHostLabels([makeFolderWorkspace()], [LOCAL_HOST], false)

    expect(labels.size).toBe(0)
  })
})
