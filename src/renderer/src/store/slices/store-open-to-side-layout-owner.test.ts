// Open to the side in a layout-owner build (ORCA_LAYOUT_OWNER=main): each new split reaches main
// with its tab, and the window draws main's frames, so both show the same groups after every step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'
import { recordOpenedAgentSessionTabInLayoutOwner } from '@/runtime/agent-session-tab-layout-owner'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
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
let main: TabsDrawnFromMain
let sentSoFar = 0

beforeEach(async () => {
  store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    groupsByWorktree: { [WT]: [{ id: ROOT, worktreeId: WT, activeTabId: null, tabOrder: [] }] },
    activeGroupIdByWorktree: { [WT]: ROOT },
    unifiedTabsByWorktree: { [WT]: [] }
  })
  main = await drawTabsFromMain(store)
  sentSoFar = 0
})

afterEach(() => {
  main.close()
})

/** What the window sent since the last call, once main answered it and its frames are drawn. */
async function settledSent(): Promise<LayoutCommand[]> {
  await main.settle()
  const sent = layoutApplyTestTransport.sent.slice(sentSoFar)
  sentSoFar = layoutApplyTestTransport.sent.length
  return [...sent]
}

/** Groups by id: the detector matches them by id, and main appends a group the window kept. */
function byId(groups: readonly { id: string; tabOrder: string[] }[]) {
  return groups
    .map(({ id, tabOrder }) => ({ id, tabOrder }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** The window's groups that hold tabs: main stores no empty group. */
function windowView() {
  const state = store.getState()
  return {
    groups: byId((state.groupsByWorktree[WT] ?? []).filter((group) => group.tabOrder.length > 0)),
    tree: splitTree(state.layoutByWorktree[WT])
  }
}

function mainView() {
  const workspace = layoutApplyTestTransport.mainModel!.workspaces[WT]!
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

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('open to the side in a layout-owner build', () => {
  it('makes each new split in main with its tab, so main and the window agree after every step', async () => {
    openFile('/a.ts')
    await settledSent()
    expect(mainView()).toEqual(windowView())

    // An editor open to the side: an empty split first, then the open fills it.
    const editorGroup = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/a.ts', { targetGroupId: editorGroup })
    expect(await settledSent()).toEqual([
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
    expect(await settledSent()).toEqual([
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

  it('keeps the source split’s preview: a preview opened to the side replaces nothing', async () => {
    openFile('/p.ts', { preview: true })
    await settledSent()
    const side = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/q.ts', { preview: true, targetGroupId: side })
    await settledSent()

    expect(mainView()).toEqual(windowView())
    expect(
      layoutApplyTestTransport.mainModel!.workspaces[WT]!.tabs.filter((tab) => tab.isPreview)
    ).toHaveLength(2)
  })

  it('opens a tab beside the emptied root split, whose group main makes its only one', async () => {
    const editorGroup = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/a.ts', { targetGroupId: editorGroup })
    await settledSent()

    // Main stores no empty group: its frame shows the opened split alone.
    expect(mainView()).toEqual({
      groups: [{ id: editorGroup, tabOrder: [onlyTabOf(editorGroup)] }],
      tree: null
    })
    expect(mainView()).toEqual(windowView())
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
    async (_kind, openIntoRoot) => {
      // The splits beside the emptied root hold tabs, so main has only those.
      store.getState().createTab(WT, undefined, undefined, {
        split: { sourceGroupId: ROOT, splitDirection: 'right' }
      })
      const right = store.getState().groupsByWorktree[WT]!.at(-1)!.id
      store.getState().createTab(WT, undefined, undefined, {
        split: { sourceGroupId: right, splitDirection: 'down' }
      })
      await settledSent()

      openIntoRoot()
      await settledSent()
      expect(mainView()).toEqual(windowView())
    }
  )

  it('records opens into a split made off another empty split, beside the groups main holds', async () => {
    openFile('/a.ts')
    await settledSent()
    const outer = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    const inner = store.getState().createEmptySplitGroup(WT, outer, 'down')!

    // The inner group's sibling is the outer one, which main lacks until its own first tab.
    openFile('/b.ts', { targetGroupId: inner })
    await settledSent()
    expect(mainView()).toEqual(windowView())
    const again = store.getState().createEmptySplitGroup(WT, inner, 'up')!
    openFile('/c.ts', { targetGroupId: again })
    await settledSent()
    expect(mainView()).toEqual(windowView())
  })

  it('sends no split for a tab that joins a group holding others, or the only group', async () => {
    openFile('/a.ts')
    openFile('/b.ts')
    store.getState().createTab(WT)

    expect((await settledSent()).map((command) => 'split' in command)).toEqual([
      false,
      false,
      false
    ])
    expect(mainView()).toEqual(windowView())
  })
})

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('open to the side with the switch off', () => {
  it('sends nothing', () => {
    openFile('/a.ts')
    const side = store.getState().createEmptySplitGroup(WT, ROOT, 'right')!
    openFile('/b.ts', { targetGroupId: side })
    store.getState().createTab(WT, undefined, undefined, {
      split: { sourceGroupId: ROOT, splitDirection: 'down' }
    })

    expect(layoutApplyTestTransport.sent).toEqual([])
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
