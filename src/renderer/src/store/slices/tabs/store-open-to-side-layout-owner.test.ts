// With main layout ownership, each split and tab must reach main together; drawn frames must preserve group parity.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { createStoreCascadesMockApi } from '../../testing/app-store-cascade-api.test-fixture'
import '@/runtime/workspace-layout/commands/layout-owner-new-group-split'
import { openContentTabThroughLayoutOwner } from '@/runtime/workspace-layout/intents/layout-owner-content-tab-open'
import { contentTabOpenPlacement } from './content-tab-open-placement'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { LayoutCommand } from '../../../../../shared/workspace-layout/workspace-layout-command-types'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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

    store.getState().createTab(WT, undefined, undefined, {
      split: { sourceGroupId: editorGroup, splitDirection: 'down' }
    })
    const terminalGroup = store.getState().groupsByWorktree[WT]!.at(-1)!.id
    const browser = store.getState().createBrowserTab(WT, 'about:blank', {
      split: { sourceGroupId: ROOT, splitDirection: 'left' }
    })
    const sentNow = await settledSent()
    const browserGroup = store
      .getState()
      .unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === browser.id)!.groupId
    expect(sentNow).toEqual([
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
        // As openAgentSessionTabThroughLayoutOwner does, on this test's store.
        const tabId = 'agent-session:chat-1'
        const placement = contentTabOpenPlacement(store.getState(), WT, tabId, {
          targetGroupId: ROOT
        })!
        openContentTabThroughLayoutOwner(store.getState(), {
          worktreeId: WT,
          entityId: 'chat-1',
          command: {
            type: 'openAgentSessionTab',
            tabId,
            sessionId: 'chat-1',
            agent: 'codex',
            ...placement
          },
          facts: { label: 'Codex' },
          shown: () => {},
          drawHere: () => null
        })
      }
    ]
  ])(
    'opens a %s tab into the emptied root after its neighbour split again',
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
})
