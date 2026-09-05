import { describe, expect, it } from 'vitest'
import type { WorkspaceMultiplexerState } from '../../../../shared/workspace-multiplexer-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorkspaceMultiplexerCatalog,
  findWorkspaceMultiplexerSlotTerminalTab,
  groupWorkspaceMultiplexerCatalog,
  reconcileWorkspaceMultiplexerState,
  selectWorkspaceMultiplexerGroup,
  workspaceMultiplexerOwnsTerminalTabs,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'
import {
  dropWorkspaceMultiplexerSlot,
  getWorkspaceMultiplexerLayoutPaneIds,
  insertWorkspaceMultiplexerSlot
} from './workspace-multiplexer-layout'

const multiplexer: WorkspaceMultiplexerState = {
  slots: [
    {
      id: 'slot-a',
      worktreeId: 'worktree-a',
      groupId: 'group-a',
      activeTerminalTabId: 'terminal-a'
    }
  ],
  panes: [{ id: 'slot-a', activeSlotId: 'slot-a', slotOrder: ['slot-a'] }],
  layout: { type: 'leaf', groupId: 'slot-a' }
}

describe('Workspace Multiplexer model', () => {
  it('preserves unavailable workspace selections', () => {
    expect(reconcileWorkspaceMultiplexerState(multiplexer, {}, {}, [])).toBe(multiplexer)
  })

  it('keeps an inserted slot reachable when its source is stale', () => {
    const next = insertWorkspaceMultiplexerSlot(
      multiplexer,
      {
        id: 'slot-b',
        worktreeId: 'worktree-b',
        groupId: null,
        activeTerminalTabId: null
      },
      'missing-slot'
    )

    expect(next.layout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: multiplexer.layout,
      second: { type: 'leaf', groupId: 'slot-b' },
      ratio: 0.5
    })
    expect(next.panes.at(-1)).toEqual({
      id: 'slot-b',
      activeSlotId: 'slot-b',
      slotOrder: ['slot-b']
    })
  })

  it('selects an existing terminal group before an empty or editor group', () => {
    const groups: TabGroup[] = [
      { id: 'editor-group', worktreeId: 'worktree-a', activeTabId: 'editor', tabOrder: ['editor'] },
      {
        id: 'terminal-group',
        worktreeId: 'worktree-a',
        activeTabId: 'terminal',
        tabOrder: ['terminal']
      }
    ]
    const tabs: Tab[] = [
      {
        id: 'editor',
        entityId: 'file.ts',
        groupId: 'editor-group',
        worktreeId: 'worktree-a',
        contentType: 'editor',
        label: 'file.ts',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: 'terminal',
        entityId: 'terminal-entity',
        groupId: 'terminal-group',
        worktreeId: 'worktree-a',
        contentType: 'terminal',
        label: 'Terminal',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]

    expect(
      selectWorkspaceMultiplexerGroup({
        groups,
        tabs,
        representedGroupIds: new Set(),
        activeGroupId: 'editor-group'
      })
    ).toEqual({ groupId: 'terminal-group', activeTerminalTabId: 'terminal-entity' })
  })

  it('merges workspace tabs and can split one back onto a pane edge', () => {
    const withSecond = insertWorkspaceMultiplexerSlot(
      multiplexer,
      {
        id: 'slot-b',
        worktreeId: 'worktree-b',
        groupId: 'group-b',
        activeTerminalTabId: 'terminal-b'
      },
      'slot-a'
    )

    const merged = dropWorkspaceMultiplexerSlot(withSecond, 'slot-a', {
      paneId: 'slot-b',
      targetSlotId: 'slot-b',
      insertSide: 'right'
    })

    expect(merged.panes).toEqual([
      { id: 'slot-b', activeSlotId: 'slot-a', slotOrder: ['slot-b', 'slot-a'] }
    ])
    expect(getWorkspaceMultiplexerLayoutPaneIds(merged.layout)).toEqual(['slot-b'])

    const split = dropWorkspaceMultiplexerSlot(merged, 'slot-a', {
      paneId: 'slot-b',
      splitDirection: 'left'
    })
    expect(split.panes).toHaveLength(2)
    expect(split.panes.find((pane) => pane.id === 'slot-b')).toEqual({
      id: 'slot-b',
      activeSlotId: 'slot-b',
      slotOrder: ['slot-b']
    })
    expect(split.panes.find((pane) => pane.slotOrder.includes('slot-a'))?.slotOrder).toEqual([
      'slot-a'
    ])
    expect(getWorkspaceMultiplexerLayoutPaneIds(split.layout)[1]).toBe('slot-b')
  })

  it('inserts beside a moved slot instead of the pane that inherited its id', () => {
    const withSecond = insertWorkspaceMultiplexerSlot(
      multiplexer,
      {
        id: 'slot-b',
        worktreeId: 'worktree-b',
        groupId: 'group-b',
        activeTerminalTabId: 'terminal-b'
      },
      'slot-a'
    )
    const tabbed = dropWorkspaceMultiplexerSlot(withSecond, 'slot-b', {
      paneId: 'slot-a',
      targetSlotId: 'slot-a',
      insertSide: 'right'
    })
    const withTarget = insertWorkspaceMultiplexerSlot(
      tabbed,
      {
        id: 'slot-target',
        worktreeId: 'worktree-target',
        groupId: null,
        activeTerminalTabId: null
      },
      'slot-a'
    )
    const moved = dropWorkspaceMultiplexerSlot(withTarget, 'slot-a', {
      paneId: 'slot-target',
      targetSlotId: 'slot-target',
      insertSide: 'right'
    })
    const inserted = insertWorkspaceMultiplexerSlot(
      moved,
      {
        id: 'slot-c',
        worktreeId: 'worktree-c',
        groupId: null,
        activeTerminalTabId: null
      },
      'slot-a'
    )

    expect(getWorkspaceMultiplexerLayoutPaneIds(inserted.layout)).toEqual([
      'slot-a',
      'slot-target',
      'slot-c'
    ])
  })

  it('stops routing a terminal to a slot once the tab moved to another group', () => {
    const slot = multiplexer.slots[0]!
    const terminal: Tab = {
      id: 'tab-a',
      entityId: 'terminal-a',
      groupId: 'group-a',
      worktreeId: 'worktree-a',
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }

    expect(findWorkspaceMultiplexerSlotTerminalTab(slot, [terminal])).toBe(terminal)
    expect(
      findWorkspaceMultiplexerSlotTerminalTab(slot, [{ ...terminal, groupId: 'group-b' }])
    ).toBeUndefined()
    expect(
      findWorkspaceMultiplexerSlotTerminalTab({ ...slot, groupId: null }, [terminal])
    ).toBeUndefined()
  })

  it('groups worktrees under their project identity', () => {
    const item = {
      identity: 'local|worktree-a',
      projectIdentity: 'repo:one:local',
      worktreeId: 'worktree-a',
      executionHostId: 'local',
      projectName: 'Orca',
      projectGroupName: null,
      projectBadgeColor: null,
      workspaceName: 'anglerfish',
      workspaceKind: 'worktree',
      branch: 'feature/multiplexer',
      isMainWorktree: false,
      workspaceStatus: 'in-progress',
      path: '/repo/anglerfish',
      hostLabel: null
    } satisfies WorkspaceMultiplexerCatalogItem
    const groups = groupWorkspaceMultiplexerCatalog([
      item,
      { ...item, identity: 'local|worktree-b', worktreeId: 'worktree-b' }
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.items.map((entry) => entry.worktreeId)).toEqual(['worktree-a', 'worktree-b'])
  })

  it('omits host-colliding workspaces while terminal state is bare-id keyed', () => {
    const worktree = {
      id: 'repo::/workspace',
      repoId: 'repo',
      path: '/workspace',
      branch: 'main',
      head: 'abc123',
      isBare: false,
      isMainWorktree: true,
      displayName: 'workspace',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    } satisfies Omit<Worktree, 'hostId'>

    const catalog = buildWorkspaceMultiplexerCatalog({
      worktrees: [
        { ...worktree, hostId: 'local' },
        { ...worktree, hostId: 'ssh:build-box' }
      ],
      folderWorkspaces: [],
      repos: [],
      projectGroups: []
    })

    expect(catalog).toEqual([])
  })

  it('rejects terminal state owned by another execution host', () => {
    const workspace = {
      identity: 'ssh:build-box|worktree-a',
      projectIdentity: 'repo:one:ssh:build-box',
      worktreeId: 'worktree-a',
      executionHostId: 'ssh:build-box',
      runtimeOwnerEnvironmentId: 'runtime-a',
      projectName: 'Orca',
      projectGroupName: null,
      projectBadgeColor: null,
      workspaceName: 'anglerfish',
      workspaceKind: 'worktree',
      branch: 'feature/multiplexer',
      isMainWorktree: false,
      workspaceStatus: 'in-progress',
      path: '/repo/anglerfish',
      hostLabel: 'Build box'
    } satisfies WorkspaceMultiplexerCatalogItem
    const terminal = {
      id: 'terminal',
      entityId: 'terminal-entity',
      groupId: 'group-a',
      worktreeId: 'worktree-a',
      executionHostId: 'runtime:runtime-a',
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    } satisfies Tab

    expect(workspaceMultiplexerOwnsTerminalTabs(workspace, [terminal])).toBe(true)
    expect(
      workspaceMultiplexerOwnsTerminalTabs(workspace, [
        { ...terminal, executionHostId: 'ssh:other-box' }
      ])
    ).toBe(false)
    const legacyTerminal = { ...terminal, executionHostId: undefined }
    expect(workspaceMultiplexerOwnsTerminalTabs(workspace, [legacyTerminal])).toBe(false)
    expect(
      workspaceMultiplexerOwnsTerminalTabs(workspace, [legacyTerminal], 'runtime:runtime-a')
    ).toBe(true)
    expect(
      workspaceMultiplexerOwnsTerminalTabs(
        {
          ...workspace,
          executionHostId: 'local',
          runtimeOwnerEnvironmentId: undefined
        },
        [legacyTerminal]
      )
    ).toBe(true)
  })
})
