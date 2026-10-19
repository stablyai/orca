import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'
import { recordOpenedAgentSessionTabInLayoutOwner } from '@/runtime/agent-session-tab-layout-owner'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { LayoutApplyParams } from '../../../../shared/rpc-contract/workspace-layout-params'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(async (_target: unknown, _method: string, _params: unknown) => ({
    ok: true,
    result: {}
  }))
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const ROOT = 'group-root'

let store: ReturnType<typeof createTestStore>
/** Main's copy; it changes only through what the window sends. */
let main: WorkspaceLayoutModel

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    groupsByWorktree: { [WT]: [{ id: ROOT, worktreeId: WT, activeTabId: null, tabOrder: [] }] },
    activeGroupIdByWorktree: { [WT]: ROOT },
    unifiedTabsByWorktree: { [WT]: [] }
  })
  main = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {},
    records: {},
    legacy: { terminalRowOwners: {} }
  }
})

/** Applies what the window sent to main's copy, as `layout.apply` does; any refusal fails. */
function applySent() {
  const calls = mocks.callRuntimeRpc.mock.calls
  expect(calls.every(([, method]) => method === 'layout.apply')).toBe(true)
  // Through the RPC's schema, as main receives them.
  const commands = calls.map(([, , params]) => LayoutApplyParams.parse(params).command)
  mocks.callRuntimeRpc.mockClear()
  let id = 0
  for (const command of commands) {
    const applied = applyLayoutCommand(main, command, {
      mintId: () => `main-${++id}`,
      mintLeafId: () => `leaf-${++id}`,
      now: () => 1
    })
    if (!applied.ok) {
      throw new Error(`${command.type} refused: ${applied.code}`)
    }
    main = applied.model
  }
  return commands
}

/** Groups by id: the detector matches them by id, and main appends a group the window kept. */
function byId(groups: readonly { id: string; tabOrder: string[] }[]) {
  return groups
    .map(({ id, tabOrder }) => ({ id, tabOrder }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function windowView() {
  const state = store.getState()
  return {
    groups: byId(state.groupsByWorktree[WT] ?? []),
    tree: splitTree(state.layoutByWorktree[WT])
  }
}

function mainView() {
  const workspace = main.workspaces[WT]!
  return {
    groups: byId(workspace.groups),
    tree: splitTree(workspace.groupLayout)
  }
}

/** A lone group's tree is implied: the window stores its leaf, main none. */
function splitTree(tree: TabGroupLayoutNode | undefined): TabGroupLayoutNode | null {
  return tree?.type === 'split' ? tree : null
}

function openFile(path: string, options?: { preview?: boolean; targetGroupId?: string }) {
  store
    .getState()
    .openFile(
      { filePath: path, relativePath: path.slice(1), worktreeId: WT, language: 'ts', mode: 'edit' },
      options
    )
}

function onlyTabOf(groupId: string): string {
  const group = store.getState().groupsByWorktree[WT]!.find((entry) => entry.id === groupId)!
  expect(group.tabOrder).toHaveLength(1)
  return group.tabOrder[0]!
}

describe('open to the side in a layout-owner build', () => {
  it('makes each new split in main with its tab, so main and the window agree after every step', () => {
    openFile('/a.ts')
    applySent()
    expect(mainView()).toEqual(windowView())

    // An editor open to the side: an empty split first, then the open fills it.
    const editorGroup = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/a.ts', { targetGroupId: editorGroup })
    expect(applySent()).toEqual([
      expect.objectContaining({
        type: 'openEditorTab',
        tabId: onlyTabOf(editorGroup),
        groupId: editorGroup,
        split: { besideGroupId: ROOT, direction: 'right' }
      })
    ])
    expect(mainView()).toEqual(windowView())

    // A terminal and a browser tab made with their split, beside the editor's split.
    store.getState().createTab(WT, undefined, undefined, {
      split: { sourceGroupId: editorGroup, splitDirection: 'down' }
    })
    const terminalGroup = store.getState().groupsByWorktree[WT]!.at(-1)!.id
    store.getState().createBrowserTab(WT, 'about:blank', {
      split: { sourceGroupId: ROOT, splitDirection: 'left' }
    })
    const browserGroup = store.getState().groupsByWorktree[WT]!.at(-1)!.id
    expect(applySent()).toEqual([
      expect.objectContaining({
        type: 'createTerminalTab',
        tabId: onlyTabOf(terminalGroup),
        groupId: terminalGroup,
        split: { besideGroupId: editorGroup, direction: 'down' }
      }),
      expect.objectContaining({
        type: 'openBrowserTab',
        tabId: onlyTabOf(browserGroup),
        groupId: browserGroup,
        split: { besideGroupId: ROOT, direction: 'left' }
      })
    ])
    expect(mainView()).toEqual(windowView())
    expect(mainView().groups).toHaveLength(4)
  })

  it('keeps the source split’s preview: a preview opened to the side replaces nothing', () => {
    openFile('/p.ts', { preview: true })
    applySent()
    const side = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/q.ts', { preview: true, targetGroupId: side })
    applySent()

    expect(mainView()).toEqual(windowView())
    expect(main.workspaces[WT]!.tabs.filter((tab) => tab.isPreview)).toHaveLength(2)
  })

  it('records a tab opened beside the emptied root split, whose group main makes its only one', () => {
    const editorGroup = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/a.ts', { targetGroupId: editorGroup })
    applySent()

    // The window keeps its empty root beside it; main stores no empty group.
    expect(windowView().groups).toEqual(
      byId([
        { id: ROOT, tabOrder: [] },
        { id: editorGroup, tabOrder: [onlyTabOf(editorGroup)] }
      ])
    )
    expect(mainView()).toEqual({
      groups: [{ id: editorGroup, tabOrder: [onlyTabOf(editorGroup)] }],
      tree: null
    })
  })

  it.each([
    ['terminal', () => store.getState().createTab(WT, ROOT)],
    ['editor', () => openFile('/c.ts', { targetGroupId: ROOT })],
    [
      'browser',
      () => store.getState().createBrowserTab(WT, 'about:blank', { targetGroupId: ROOT })
    ],
    [
      'chat',
      () => {
        // As openStructuredAgentSessionProvisionalTab does, on this test's store.
        const tab = store.getState().createUnifiedTab(WT, 'agent-session', {
          entityId: 'chat-1',
          agentSessionAgent: 'codex',
          targetGroupId: ROOT
        })
        recordOpenedAgentSessionTabInLayoutOwner(store.getState(), tab)
      }
    ]
  ])(
    'records a %s tab opened into the emptied root after its neighbour split again',
    (_kind, openIntoRoot) => {
      // The window keeps its emptied root; the splits beside it hold tabs, so main has only those.
      store.getState().createTab(WT, undefined, undefined, {
        split: { sourceGroupId: ROOT, splitDirection: 'right' }
      })
      const right = store.getState().groupsByWorktree[WT]!.at(-1)!.id
      store.getState().createTab(WT, undefined, undefined, {
        split: { sourceGroupId: right, splitDirection: 'down' }
      })
      applySent()
      expect(windowView().groups).toContainEqual({ id: ROOT, tabOrder: [] })

      openIntoRoot()
      applySent()
      expect(mainView()).toEqual(windowView())
    }
  )

  it('records opens into a split made off another empty split, beside the groups main holds', () => {
    openFile('/a.ts')
    const outer = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    const inner = store.getState().createEmptySplitGroup(WT, outer, 'down')!
    applySent()

    // The inner group's sibling is the outer one, which main lacks until its own first tab.
    openFile('/b.ts', { targetGroupId: inner })
    applySent()
    store.getState().closeEmptyGroup(WT, outer)
    expect(mainView()).toEqual(windowView())
    const again = store.getState().createEmptySplitGroup(WT, inner, 'up')!
    openFile('/c.ts', { targetGroupId: again })
    applySent()
    expect(mainView()).toEqual(windowView())
  })

  it('sends no split for a tab that joins a group holding others, or the only group', () => {
    openFile('/a.ts')
    openFile('/b.ts')
    store.getState().createTab(WT)

    expect(applySent().map((command) => 'split' in command)).toEqual([false, false, false])
    expect(mainView()).toEqual(windowView())
  })

  it('sends nothing with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    openFile('/a.ts')
    const side = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/b.ts', { targetGroupId: side })
    store.getState().createTab(WT, undefined, undefined, {
      split: { sourceGroupId: ROOT, splitDirection: 'down' }
    })

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('newGroupSplitOf', () => {
  it('names a sibling that is itself split by its first and last groups', () => {
    const group = (id: string, tabOrder: string[]) => ({
      id,
      worktreeId: WT,
      activeTabId: null,
      tabOrder
    })
    const state = {
      groupsByWorktree: { [WT]: [group('A', ['a']), group('M', ['m']), group('N', ['n'])] },
      layoutByWorktree: {
        [WT]: {
          type: 'split' as const,
          direction: 'horizontal' as const,
          first: {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, groupId: 'A' },
            second: { type: 'leaf' as const, groupId: 'M' }
          },
          second: { type: 'leaf' as const, groupId: 'N' }
        }
      }
    }

    expect(newGroupSplitOf(state, WT, 'N', 'n')).toEqual({
      split: { besideGroupId: 'A', besideLastGroupId: 'M', direction: 'right' }
    })
  })
})
