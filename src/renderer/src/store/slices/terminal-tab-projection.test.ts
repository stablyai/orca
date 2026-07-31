import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import {
  ensureTerminalTabProjection,
  hasTerminalTabProjectionInvariant,
  type EnsureTerminalTabProjectionOutcome,
  type EnsureTerminalTabProjectionSkipReason
} from './terminal-tab-projection'

type ProjectionState = Parameters<typeof ensureTerminalTabProjection>[0]

const WORKTREE_ID = 'repo::/tmp/background'

function makeBackingTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'terminal-1',
    ptyId: 'pty-live',
    worktreeId: WORKTREE_ID,
    title: 'Terminal 3',
    generatedTitle: 'Fix the projection',
    quickCommandLabel: 'Claude',
    customTitle: null,
    color: '#00ff00',
    isPinned: true,
    viewMode: 'chat',
    sortOrder: 2,
    createdAt: 30,
    pendingActivationSpawn: true,
    ...overrides
  }
}

function makeState(overrides: Partial<ProjectionState> = {}): ProjectionState {
  return {
    tabsByWorktree: { [WORKTREE_ID]: [makeBackingTab()] },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    activeTabIdByWorktree: {},
    ...overrides
  }
}

function applyOutcome(
  state: ProjectionState,
  patch: EnsureTerminalTabProjectionOutcome['patch']
): ProjectionState {
  return { ...state, ...patch }
}

function makeEditorTab(groupId: string): Tab {
  return {
    id: 'editor-1',
    entityId: '/tmp/background/file.ts',
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'file.ts',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 10
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: WORKTREE_ID,
    activeTabId: 'editor-1',
    tabOrder: ['editor-1'],
    recentTabIds: ['editor-1'],
    ...overrides
  }
}

describe('ensureTerminalTabProjection', () => {
  it('adds a missing terminal projection without changing the selected foreground tab', () => {
    const group = makeGroup()
    const editor = makeEditorTab(group.id)
    const state = makeState({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [editor] },
      groupsByWorktree: { [WORKTREE_ID]: [group] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: group.id },
      layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: group.id } },
      activeTabIdByWorktree: { [WORKTREE_ID]: 'terminal-1' }
    })

    const outcome = ensureTerminalTabProjection(
      state,
      WORKTREE_ID,
      'terminal-1',
      undefined,
      () => 'unused-group'
    )
    const repaired = applyOutcome(state, outcome.patch)

    expect(outcome.result.status).toBe('repaired')
    expect(hasTerminalTabProjectionInvariant(repaired, WORKTREE_ID, 'terminal-1')).toBe(true)
    expect(repaired.unifiedTabsByWorktree[WORKTREE_ID][0]).toBe(editor)
    expect(repaired.groupsByWorktree[WORKTREE_ID][0]).toMatchObject({
      activeTabId: 'editor-1',
      tabOrder: ['editor-1', 'terminal-1'],
      recentTabIds: ['editor-1']
    })
    expect(repaired.activeGroupIdByWorktree[WORKTREE_ID]).toBe(group.id)
    expect(repaired.tabsByWorktree).toBe(state.tabsByWorktree)

    const replay = ensureTerminalTabProjection(
      repaired,
      WORKTREE_ID,
      'terminal-1',
      undefined,
      () => 'unused-group'
    )
    expect(replay).toEqual({
      result: { status: 'unchanged', tabId: 'terminal-1', groupId: group.id },
      patch: {}
    })
  })

  it('creates one root group and copies stable terminal presentation metadata', () => {
    const state = makeState()
    const outcome = ensureTerminalTabProjection(
      state,
      WORKTREE_ID,
      'terminal-1',
      undefined,
      () => 'root-group'
    )
    const repaired = applyOutcome(state, outcome.patch)
    const projection = repaired.unifiedTabsByWorktree[WORKTREE_ID][0]

    expect(projection).toMatchObject({
      id: 'terminal-1',
      entityId: 'terminal-1',
      groupId: 'root-group',
      label: 'Terminal 3',
      generatedLabel: 'Fix the projection',
      quickCommandLabel: 'Claude',
      color: '#00ff00',
      isPinned: true,
      viewMode: 'chat',
      sortOrder: 2,
      createdAt: 30
    })
    expect(repaired.groupsByWorktree[WORKTREE_ID]).toEqual([
      {
        id: 'root-group',
        worktreeId: WORKTREE_ID,
        activeTabId: 'terminal-1',
        tabOrder: ['terminal-1']
      }
    ])
    expect(repaired.layoutByWorktree[WORKTREE_ID]).toEqual({
      type: 'leaf',
      groupId: 'root-group'
    })
    expect(repaired.activeGroupIdByWorktree[WORKTREE_ID]).toBe('root-group')
  })

  it('canonicalizes duplicate aliases and order occurrences for only the target terminal', () => {
    const group = makeGroup({
      activeTabId: 'terminal-alias-2',
      tabOrder: ['editor-1', 'terminal-alias-1', 'terminal-alias-1', 'terminal-alias-2'],
      recentTabIds: ['editor-1', 'terminal-alias-1', 'terminal-alias-2']
    })
    const editor = makeEditorTab(group.id)
    const aliases: Tab[] = ['terminal-alias-1', 'terminal-alias-2'].map((id, index) => ({
      id,
      entityId: 'terminal-1',
      groupId: group.id,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: `Alias ${index + 1}`,
      customLabel: null,
      color: null,
      sortOrder: index + 1,
      createdAt: index + 20
    }))
    const state = makeState({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [editor, ...aliases] },
      groupsByWorktree: { [WORKTREE_ID]: [group] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: group.id },
      layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: group.id } }
    })

    const outcome = ensureTerminalTabProjection(
      state,
      WORKTREE_ID,
      'terminal-1',
      undefined,
      () => 'unused-group'
    )
    const repaired = applyOutcome(state, outcome.patch)

    expect(outcome.result).toMatchObject({
      status: 'repaired',
      removedProjectionCount: 1,
      removedOrderOccurrenceCount: 2
    })
    expect(repaired.unifiedTabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'editor-1',
      'terminal-alias-2'
    ])
    expect(repaired.groupsByWorktree[WORKTREE_ID][0]).toMatchObject({
      activeTabId: 'terminal-alias-2',
      tabOrder: ['editor-1', 'terminal-alias-2'],
      recentTabIds: ['editor-1', 'terminal-alias-2']
    })
    expect(hasTerminalTabProjectionInvariant(repaired, WORKTREE_ID, 'terminal-1')).toBe(true)
  })
  it('keeps a populated sibling group selected while removing its stale target pointer', () => {
    const primaryGroup = makeGroup()
    const siblingGroup = makeGroup({
      id: 'group-2',
      activeTabId: 'terminal-1',
      tabOrder: ['editor-2'],
      recentTabIds: ['terminal-1', 'editor-2']
    })
    const primaryEditor = makeEditorTab(primaryGroup.id)
    const siblingEditor: Tab = {
      ...makeEditorTab(siblingGroup.id),
      id: 'editor-2',
      entityId: '/tmp/background/other.ts',
      label: 'other.ts'
    }
    const state = makeState({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [primaryEditor, siblingEditor] },
      groupsByWorktree: { [WORKTREE_ID]: [primaryGroup, siblingGroup] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: primaryGroup.id },
      layoutByWorktree: {
        [WORKTREE_ID]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: primaryGroup.id },
          second: { type: 'leaf', groupId: siblingGroup.id }
        }
      },
      activeTabIdByWorktree: { [WORKTREE_ID]: 'terminal-1' }
    })

    const outcome = ensureTerminalTabProjection(
      state,
      WORKTREE_ID,
      'terminal-1',
      undefined,
      () => 'unused-group'
    )
    const repaired = applyOutcome(state, outcome.patch)

    expect(outcome.result.status).toBe('repaired')
    expect(repaired.groupsByWorktree[WORKTREE_ID][1]).toMatchObject({
      activeTabId: 'editor-2',
      tabOrder: ['editor-2'],
      recentTabIds: ['editor-2']
    })
    expect(hasTerminalTabProjectionInvariant(repaired, WORKTREE_ID, 'terminal-1')).toBe(true)
  })
  it('honors an explicit rendered target group without changing the active group', () => {
    const primaryGroup = makeGroup()
    const targetGroup = makeGroup({
      id: 'group-2',
      activeTabId: 'editor-2',
      tabOrder: ['editor-2'],
      recentTabIds: ['editor-2']
    })
    const primaryEditor = makeEditorTab(primaryGroup.id)
    const targetEditor: Tab = {
      ...makeEditorTab(targetGroup.id),
      id: 'editor-2',
      entityId: '/tmp/background/target.ts',
      label: 'target.ts'
    }
    const state = makeState({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [primaryEditor, targetEditor] },
      groupsByWorktree: { [WORKTREE_ID]: [primaryGroup, targetGroup] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: primaryGroup.id },
      layoutByWorktree: {
        [WORKTREE_ID]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: primaryGroup.id },
          second: { type: 'leaf', groupId: targetGroup.id }
        }
      }
    })

    const outcome = ensureTerminalTabProjection(
      state,
      WORKTREE_ID,
      'terminal-1',
      targetGroup.id,
      () => 'unused-group'
    )
    const repaired = applyOutcome(state, outcome.patch)

    expect(outcome.result).toMatchObject({ status: 'repaired', groupId: targetGroup.id })
    expect(repaired.activeGroupIdByWorktree[WORKTREE_ID]).toBe(primaryGroup.id)
    expect(repaired.groupsByWorktree[WORKTREE_ID][1]).toMatchObject({
      activeTabId: 'editor-2',
      tabOrder: ['editor-2', 'terminal-1']
    })
    expect(hasTerminalTabProjectionInvariant(repaired, WORKTREE_ID, 'terminal-1')).toBe(true)
  })

  it('fails closed without mutating state for structural projection conflicts', () => {
    const aliasProjection = (id: string, groupId: string): Tab => ({
      id,
      entityId: 'terminal-1',
      groupId,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: id,
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 20
    })
    const conflictCases: {
      reason: EnsureTerminalTabProjectionSkipReason
      state: ProjectionState
      createGroupId?: () => string
    }[] = [
      {
        reason: 'missing-backing-tab',
        state: makeState({ tabsByWorktree: { [WORKTREE_ID]: [] } })
      },
      {
        reason: 'duplicate-backing-tab',
        state: makeState({
          tabsByWorktree: {
            [WORKTREE_ID]: [makeBackingTab(), makeBackingTab({ title: 'Duplicate' })]
          }
        })
      },
      {
        reason: 'duplicate-unified-id',
        state: makeState({
          unifiedTabsByWorktree: {
            [WORKTREE_ID]: [{ ...makeEditorTab('group-1'), id: 'terminal-1' }]
          }
        })
      },
      {
        reason: 'duplicate-unified-id',
        state: makeState({
          unifiedTabsByWorktree: {
            [WORKTREE_ID]: [
              aliasProjection('shared-alias', 'group-1'),
              { ...aliasProjection('shared-alias', 'group-1'), label: 'Duplicate alias id' }
            ]
          }
        })
      },
      {
        reason: 'ambiguous-active-aliases',
        state: makeState({
          unifiedTabsByWorktree: {
            [WORKTREE_ID]: [
              aliasProjection('terminal-alias-1', 'group-1'),
              aliasProjection('terminal-alias-2', 'group-2')
            ]
          },
          groupsByWorktree: {
            [WORKTREE_ID]: [
              makeGroup({
                id: 'group-1',
                activeTabId: 'terminal-alias-1',
                tabOrder: ['terminal-alias-1']
              }),
              makeGroup({
                id: 'group-2',
                activeTabId: 'terminal-alias-2',
                tabOrder: ['terminal-alias-2']
              })
            ]
          }
        })
      },
      {
        reason: 'group-id-collision',
        state: makeState({
          unifiedTabsByWorktree: {
            [WORKTREE_ID]: [aliasProjection('terminal-alias', 'colliding-group')]
          }
        }),
        createGroupId: () => 'colliding-group'
      }
    ]

    for (const { reason, state, createGroupId = () => 'unused-group' } of conflictCases) {
      const before = JSON.stringify(state)
      const outcome = ensureTerminalTabProjection(
        state,
        WORKTREE_ID,
        'terminal-1',
        undefined,
        createGroupId
      )

      expect(outcome).toEqual({
        result: { status: 'skipped', tabId: 'terminal-1', reason },
        patch: {}
      })
      expect(JSON.stringify(state)).toBe(before)
    }
  })

  it('leaves ambiguous multi-group topology byte-equivalent', () => {
    const groups = [makeGroup(), makeGroup({ id: 'group-2', activeTabId: null, tabOrder: [] })]
    const state = makeState({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [makeEditorTab('group-1')] },
      groupsByWorktree: { [WORKTREE_ID]: groups },
      activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' }
    })

    const before = JSON.stringify(state)
    const outcome = ensureTerminalTabProjection(
      state,
      WORKTREE_ID,
      'terminal-1',
      undefined,
      () => 'unused-group'
    )

    expect(outcome).toEqual({
      result: {
        status: 'skipped',
        tabId: 'terminal-1',
        reason: 'ambiguous-group-topology'
      },
      patch: {}
    })
    expect(JSON.stringify(state)).toBe(before)
  })
})
