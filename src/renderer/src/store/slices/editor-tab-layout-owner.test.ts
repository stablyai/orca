// Layout-owner editor opens/closes/promotions draw only from main frames; switch-off cases draw locally without main.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { Tab } from '../../../../shared/tab-types'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { buildEditorSessionData } from '@/lib/workspace-session'
import type { OpenFile } from './editor'
import { restorableEditorFile } from './editor/tabs/editor-tab-layout-owner'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeLayout, makeTab, makeWorktree } from './store-test-helpers'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

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

  it('sends a diff tab’s view so a reload rebuilds it', async () => {
    store.getState().openDiff(WT, '/repo/a.ts', 'a.ts', 'ts', false)
    const [command] = layoutApplyTestTransport.sentOfType('openEditorTab')
    expect(command).toMatchObject({
      contentType: 'diff',
      view: { view: { mode: 'diff' }, file: { filePath: '/repo/a.ts' } }
    })
    expect(command).not.toHaveProperty('file')
    await main.settle()
    expect(editorTabs().map((tab) => tab.contentType)).toEqual(['diff'])
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

  it('sends nothing for a reopen that leaves the record and view as main holds them', async () => {
    const a = openFile('/a.ts')
    store.getState().openDiff(WT, '/repo/b.ts', 'b.ts', 'ts', false)
    await main.settle()
    const sent = layoutApplyTestTransport.sentOfType('openEditorTab').length

    for (let click = 0; click < 3; click += 1) {
      openFile('/a.ts')
      store.getState().openDiff(WT, '/repo/b.ts', 'b.ts', 'ts', false)
    }
    await main.settle()

    expect(layoutApplyTestTransport.sentOfType('openEditorTab')).toHaveLength(sent)
    expect(tabFor(a)).toBeDefined()
  })

  it('asks main once per tab to keep a preview whose file has another open in flight', async () => {
    const explorerOpen = (path: string, targetGroupId?: string) =>
      store.getState().openFile(
        {
          filePath: path,
          relativePath: path.slice(1),
          worktreeId: WT,
          language: 'ts',
          mode: 'edit'
        },
        { preview: true, focusEditor: true, suppressActiveRuntimeFallback: true, targetGroupId }
      )
    const pkg = explorerOpen('/package.json')
    await main.settle()
    const kept = tabFor(pkg)?.id
    const groupId = store.getState().createEmptySplitGroup(WT, tabFor(pkg)?.groupId ?? '', 'right')
    // A second open of the file is in flight, and main answers the keep first.
    layoutApplyTestTransport.answerWith((command) =>
      command.type === 'openEditorTab' ? 'pending' : { ok: false, code: 'tab_not_found' }
    )
    explorerOpen('/package.json', groupId ?? undefined)
    store.getState().makePreviewFilePermanent(pkg)
    await main.settle()
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()

    const promoted = layoutApplyTestTransport
      .sentOfType('promotePreviewTab')
      .map((command) => command.tabId)
    // The kept tab once, and the in-flight open's tab once its frame draws it.
    expect(promoted.filter((tabId) => tabId === kept)).toHaveLength(1)
    expect(new Set(promoted).size).toBe(promoted.length)
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

  it('draws a diff a Source Control single click opens as a preview', async () => {
    // golden-source-control-open-diff.spec.ts: one click on an unstaged row.
    const entry = { path: 'src/index.ts', status: 'modified' as const, area: 'unstaged' as const }
    store.getState().setGitStatus(WT, { entries: [entry], conflictOperation: 'unknown' })
    store.getState().openDiff(WT, '/repo/src/index.ts', 'src/index.ts', 'typescript', false, {
      targetGroupId: undefined,
      preview: true
    })
    await main.settle()
    store.getState().setGitStatus(WT, { entries: [entry], conflictOperation: 'unknown' })
    await main.settle()

    const diff = editorTabs().find((tab) => tab.contentType === 'diff')
    expect(diff).toMatchObject({ isPreview: true })
    expect(store.getState().openFiles.map((file) => file.id)).toContain(diff?.entityId)
    expect(layoutApplyTestTransport.mainModel?.workspaces[WT]?.tabs.map((tab) => tab.id)).toEqual([
      'term',
      diff?.id
    ])
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

  it('draws nothing itself and sends nothing when a paired server owns the workspace', async () => {
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WT,
            repoId: 'repo1',
            path: '/repo',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      }
    })
    const a = openFile('/a.ts', { preview: true })
    expect(layoutApplyTestTransport.sentOfType('openEditorTab')).toEqual([])
    expect(tabFor(a)).toMatchObject({ isPreview: true })
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

  it('keeps writing the preview flag as false', () => {
    const a = openFile('/a.ts')
    const b = openFile('/b.ts', { preview: true })
    store.getState().pinTab(tabFor(b)!.id)

    expect(tabFor(a)).toHaveProperty('isPreview', false)
    expect(tabFor(b)).toHaveProperty('isPreview', false)
  })
})

it("sends an edit-mode file's record exactly as the window's session save keeps it", () => {
  const file = {
    id: 'f1',
    filePath: '/a.log',
    relativePath: 'a.log',
    worktreeId: WT,
    language: 'log',
    mode: 'edit',
    isDirty: false,
    isPreview: true,
    runtimeEnvironmentId: null,
    externalSshTargetId: 'ssh-1',
    readOnly: true,
    liveTail: true
  } satisfies OpenFile
  const saved = buildEditorSessionData([file], {}, {}, {}, {}).openFilesByWorktree?.[WT]?.[0]
  const { worktreeId: _worktreeId, isPreview: _isPreview, ...restorable } = saved ?? {}
  expect(restorableEditorFile(file)).toEqual(restorable)
})
