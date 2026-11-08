// Layout-owner editor opens/closes/promotions draw only from main frames; switch-off cases draw locally without main.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
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
vi.mock('@/lib/agent-status', async (importOriginal) => {
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
const editorTabs = (worktreeId = WT): Tab[] =>
  tabsOf(worktreeId).filter((tab) => tab.contentType !== 'terminal')
const groupOf = (groupId: string) =>
  store.getState().groupsByWorktree[WT]!.find((group) => group.id === groupId)
const tabFor = (fileId: string, groupId = g1): Tab | undefined =>
  tabsOf().find((tab) => tab.entityId === fileId && tab.groupId === groupId)

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('editor tabs drawn from main’s frame', () => {
  it('sends the open with the proposed id, group, preview and file; draws it with the frame', async () => {
    const fileId = openFile('/a.ts', { preview: true })
    const [command] = layoutApplyTestTransport.sentOfType('openEditorTab')
    expect(command).toEqual({
      type: 'openEditorTab',
      workspace: WT,
      tabId: expect.any(String),
      fileId,
      contentType: 'editor',
      groupId: g1,
      preview: true,
      file: { filePath: '/a.ts', relativePath: 'a.ts', language: 'ts' }
    })
    // The open file is the window's at once; the tab is not, until main's frame.
    expect(store.getState().openFiles.map((file) => file.id)).toContain(fileId)
    expect(tabFor(fileId)).toBeUndefined()

    await main.settle()
    // Main stamps the tab's time; the frame draws it.
    expect(tabFor(fileId)).toMatchObject({
      id: command!.tabId,
      isPreview: true,
      createdAt: expect.any(Number)
    })
  })

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

  it('leaves a replaced preview to main’s rule: it goes with the frame', async () => {
    const a = openFile('/a.ts', { preview: true })
    await main.settle()
    const b = openFile('/b.ts', { preview: true })
    // The window does not close the old preview itself.
    expect(editorTabs().map((tab) => tab.entityId)).toEqual([a])

    await main.settle()
    expect(editorTabs().map((tab) => tab.entityId)).toEqual([b])
  })

  it('opens the same file in two groups as two tabs, one per group (a)', async () => {
    const a = openFile('/a.ts')
    await main.settle()
    store.getState().createEmptySplitGroup(WT, g1, 'right')
    const g2 = store.getState().groupsByWorktree[WT]!.find((group) => group.id !== g1)!.id
    openFile('/a.ts', { targetGroupId: g2 })
    const [, split] = layoutApplyTestTransport.sentOfType('openEditorTab')
    expect(split).toMatchObject({ groupId: g2, split: { besideGroupId: g1 } })

    await main.settle()
    const tabs = editorTabs().filter((tab) => tab.entityId === a)
    expect(tabs.map((tab) => tab.groupId).toSorted()).toEqual([g1, g2].toSorted())
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2)
  })

  it('keeps one path in two workspaces on two hosts as two files and two tabs (b)', async () => {
    const other = 'repo2::/repo'
    main.close()
    seedWorkspace(store, other)
    main = await drawTabsFromMain(store)
    const local = openFile('/repo/a.ts')
    const remote = store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: other,
        language: 'ts',
        mode: 'edit',
        runtimeEnvironmentId: 'env-remote'
      },
      undefined
    )
    await main.settle()

    expect(local).not.toBe(remote)
    expect(
      store
        .getState()
        .openFiles.filter((file) => file.filePath === '/repo/a.ts')
        .map((file) => [file.worktreeId, file.id])
    ).toEqual([
      [WT, local],
      [other, remote]
    ])
    expect(editorTabs(WT).map((tab) => tab.entityId)).toEqual([local])
    expect(editorTabs(other).map((tab) => tab.entityId)).toEqual([remote])
  })

  it('sends the record an open rewrote in a tab it reuses, under that tab’s id', async () => {
    const log = { filePath: '/a.log', relativePath: 'a.log', worktreeId: WT, language: 'log' }
    const fileId = store
      .getState()
      .openFile({ ...log, mode: 'edit', readOnly: true, liveTail: true }, { preview: false })
    await main.settle()
    const tabId = tabFor(fileId)!.id
    expect(layoutApplyTestTransport.mainModel!.workspaces[WT]!.editorFiles).toEqual([
      expect.objectContaining({ filePath: '/a.log', readOnly: true, liveTail: true })
    ])

    // A normal open of the View Log path makes the same tab writable.
    store.getState().openFile({ ...log, mode: 'edit' })
    const last = layoutApplyTestTransport.sentOfType('openEditorTab').at(-1)
    expect(last).toMatchObject({ tabId, fileId, groupId: g1 })
    await main.settle()
    expect(layoutApplyTestTransport.mainModel!.workspaces[WT]!.editorFiles).toEqual([
      { filePath: '/a.log', relativePath: 'a.log', language: 'log' }
    ])
    expect(tabFor(fileId)?.id).toBe(tabId)
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

  it('closes a tab only with the frame, and its content after it (d)', async () => {
    openFile('/a.ts')
    const b = openFile('/b.ts')
    await main.settle()
    store.getState().setEditorDraft(b, 'draft')

    store.getState().closeFile(b)
    expect(layoutApplyTestTransport.sentOfType('closeTabs')).toEqual([
      { type: 'closeTabs', workspace: WT, tabIds: [tabFor(b)!.id] }
    ])
    expect(tabFor(b)).toBeDefined()
    expect(store.getState().editorDrafts[b]).toBe('draft')

    await main.settle()
    expect(tabFor(b)).toBeUndefined()
    expect(store.getState().openFiles.map((file) => file.id)).not.toContain(b)
    expect(store.getState().editorDrafts[b]).toBeUndefined()
  })

  it('keeps a tab, and its content, when main refuses the close (d)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = openFile('/a.ts')
    await main.settle()
    layoutApplyTestTransport.answerWith({ refuse: 'tab_not_found' })

    store.getState().closeFile(a)
    await main.settle()
    expect(tabFor(a)).toBeDefined()
    expect(store.getState().openFiles.map((file) => file.id)).toContain(a)
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

  it('reopens a closed tab at its place with one open (index)', async () => {
    const a = openFile('/a.ts')
    const b = openFile('/b.ts')
    const c = openFile('/c.ts')
    await main.settle()
    store.getState().closeFile(b)
    await main.settle()
    const sentBefore = layoutApplyTestTransport.sent.length

    expect(store.getState().reopenClosedEditorTab(WT)).toBe(true)
    const reopened = layoutApplyTestTransport.sent.slice(sentBefore)
    expect(reopened.map((command) => command.type)).toEqual(['openEditorTab'])
    expect(reopened[0]).toMatchObject({ fileId: b, groupId: g1, index: 2 })

    await main.settle()
    expect(
      groupOf(g1)!.tabOrder.map((id) => tabsOf().find((tab) => tab.id === id)?.entityId)
    ).toEqual(['term', a, b, c])
  })

  it('clears a promoted preview with the frame (e)', async () => {
    const a = openFile('/a.ts', { preview: true })
    await main.settle()
    const tabId = tabFor(a)!.id

    store.getState().activateTab(tabId)
    expect(layoutApplyTestTransport.sentOfType('promotePreviewTab')).toEqual([
      { type: 'promotePreviewTab', workspace: WT, tabId }
    ])
    expect(tabFor(a)?.isPreview).toBe(true)
    await main.settle()
    expect(tabFor(a)).not.toHaveProperty('isPreview')

    const b = openFile('/b.ts', { preview: true })
    await main.settle()
    store.getState().markFileDirty(b, true)
    store.getState().markFileDirty(b, true)
    expect(layoutApplyTestTransport.sentOfType('promotePreviewTab')).toHaveLength(2)
    await main.settle()
    expect(tabFor(b)).not.toHaveProperty('isPreview')
  })
})

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('editor tabs with the switch off', () => {
  it('draws at once and sends nothing', () => {
    const b = openFile('/b.ts', { preview: true })
    expect(tabFor(b)).toBeDefined()
    store.getState().activateTab(tabFor(b)!.id)
    store.getState().closeFile(b)
    expect(tabFor(b)).toBeUndefined()
    expect(layoutApplyTestTransport.sent).toEqual([])
  })
})
