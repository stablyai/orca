import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import type { Tab } from '../../../../../../shared/tab-types'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

import { createTabsSliceMockApi } from '../../tabs/tabs-slice-test-harness'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeLayout, makeTab } from '../../../terminals/terminal-tab.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'

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
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createTabsSliceMockApi()

const WT = 'repo1::/repo'

let store: ReturnType<typeof createTestStore>
let main: TabsDrawnFromMain
/** The workspace's group as main's frame shows it. */
let g1: string

/** One terminal tab, so main holds the workspace and its group from the start. */
function seedWorkspace(target: ReturnType<typeof createTestStore>, worktreeId: string): void {
  target.setState((state) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [worktreeId]: [makeTab({ id: 'term', worktreeId })]
    },
    terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId, term: makeLayout() }
  }))
  target.getState().createUnifiedTab(worktreeId, 'terminal', { id: 'term' })
}

beforeEach(async () => {
  store = createTestStore()
  seedWorkspace(store, WT)
  main = await drawTabsFromMain(store)
  g1 = store.getState().groupsByWorktree[WT]![0]!.id
})

afterEach(() => {
  main.close()
})

function openFile(
  path: string,
  options?: { preview?: boolean; targetGroupId?: string },
  worktreeId = WT
): string {
  return store.getState().openFile(
    {
      filePath: path,
      relativePath: path.slice(1),
      worktreeId,
      language: 'ts',
      mode: 'edit'
    },
    options
  )
}

const tabsOf = (worktreeId = WT): Tab[] => store.getState().unifiedTabsByWorktree[worktreeId] ?? []
const groupOf = (groupId: string) =>
  store.getState().groupsByWorktree[WT]!.find((group) => group.id === groupId)
const tabFor = (fileId: string, groupId = g1): Tab | undefined =>
  tabsOf().find((tab) => tab.entityId === fileId && tab.groupId === groupId)

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('editor tabs drawn from main’s frame', () => {
  it('selects a new tab only once its frame draws it, in that update or right after (c)', async () => {
    const updates: { drawn: boolean; selected: boolean }[] = []
    let tabId = ''
    const stop = store.subscribe((state) => {
      const drawn = (state.unifiedTabsByWorktree[WT] ?? []).some((tab) => tab.id === tabId)
      const selected =
        state.groupsByWorktree[WT]?.find((group) => group.id === g1)?.activeTabId === tabId
      updates.push({ drawn, selected })
    })
    openFile('/a.ts')
    tabId = layoutApplyTestTransport.sentOfType('openEditorTab')[0]!.tabId!
    expect(groupOf(g1)?.activeTabId).toBe('term')

    await main.settle()
    stop()
    const firstDrawn = updates.findIndex((update) => update.drawn)
    const firstSelected = updates.findIndex((update) => update.selected)
    expect(firstDrawn).toBeGreaterThanOrEqual(0)
    expect(updates.slice(0, firstDrawn).some((update) => update.selected)).toBe(false)
    expect([firstDrawn, firstDrawn + 1]).toContain(firstSelected)
    expect(groupOf(g1)?.activeTabId).toBe(tabId)
  })

  it("keeps a double-clicked Explorer file's tab when a later single click previews another", async () => {
    // editor-tab-selection-restore.spec.ts: dblclick package.json (two preview opens, then the
    // keep), wait, then single-click src/index.ts.
    const explorerOpen = (path: string) =>
      store.getState().openFile(
        {
          filePath: path,
          relativePath: path.slice(1),
          worktreeId: WT,
          language: 'ts',
          mode: 'edit'
        },
        { preview: true, focusEditor: true, suppressActiveRuntimeFallback: true }
      )
    const pkg = explorerOpen('/package.json')
    explorerOpen('/package.json')
    store.getState().makePreviewFilePermanent(pkg)
    await main.settle()
    expect(tabFor(pkg)?.isPreview).toBeFalsy()

    const index = explorerOpen('/src/index.ts')
    await main.settle()

    expect(tabFor(pkg)).toBeDefined()
    expect(tabFor(index)).toBeDefined()
    expect(
      layoutApplyTestTransport.mainModel?.workspaces[WT]?.tabs.map((tab) => tab.entityId)
    ).toEqual(['term', pkg, index])
  })

  it('drops a tab’s content when main lost its workspace before the close came in', async () => {
    const a = openFile('/a.ts')
    await main.settle()
    store.getState().setEditorDraft(a, 'draft')
    const tabId = tabFor(a)!.id
    layoutApplyTestTransport.answerWith((command) =>
      command.type === 'closeTabs' ? 'pending' : 'apply'
    )

    store.getState().closeFile(a)
    // Main drops the tab on its own (its workspace went away), then answers the window's close.
    layoutApplyTestTransport.answerWith('apply')
    await layoutApplyTestTransport.call({
      command: { type: 'closeTabs', workspace: WT, tabIds: [tabId] }
    })
    layoutApplyTestTransport.answerPending({ ok: false, code: 'workspace_not_found' })
    await main.settle()

    expect(tabFor(a)).toBeUndefined()
    expect(store.getState().openFiles.map((file) => file.id)).not.toContain(a)
    expect(store.getState().editorDrafts[a]).toBeUndefined()
  })
})
