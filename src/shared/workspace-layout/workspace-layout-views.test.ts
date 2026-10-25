import { describe, expect, it } from 'vitest'
import { asLoaded, emptyModel, WS } from './workspace-layout-command.test-fixture'
import type { LayoutTab, WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { pruneViewRecord, removeWorkspaceFromView } from './workspace-layout-view-prune'
import {
  DESKTOP_VIEW_ID,
  deviceViewId,
  emptyLayoutViewRecord,
  forgetView,
  resolveWorkspaceSelection,
  setViewRecord,
  viewRecordOf,
  type LayoutViewRecord
} from './workspace-layout-views'

const PANE_A = '00000000-0000-4000-8000-00000000000a'
const PANE_B = '00000000-0000-4000-8000-00000000000b'
const PHONE = deviceViewId('phone-1')

const tabFields = (id: string) => ({
  id,
  entityId: id,
  createdAt: 1,
  customTitle: null,
  color: null
})

/** Group g1: terminal t1 (panes A, B), editor t2; group g2: browser t3. */
function workspace(): WorkspaceLayout {
  return {
    worktreeId: WS,
    groups: [
      { id: 'g1', tabOrder: ['t1', 't2'] },
      { id: 'g2', tabOrder: ['t3'] }
    ],
    tabs: [
      {
        ...tabFields('t1'),
        kind: 'terminal',
        terminal: {},
        panes: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: PANE_A },
            second: { type: 'leaf', leafId: PANE_B }
          }
        }
      },
      { ...tabFields('t2'), entityId: '/repo/a.ts', kind: 'editor' },
      { ...tabFields('t3'), entityId: 'b1', kind: 'browser' }
    ],
    editorFiles: [{ filePath: '/repo/a.ts', relativePath: 'a.ts', language: 'typescript' }],
    browserTabs: [{ id: 'b1', createdAt: 1 }]
  }
}

function model(next: WorkspaceLayout = workspace()): WorkspaceLayoutModel {
  return { ...emptyModel(), workspaces: { [WS]: next } }
}

/** A record naming everything in the workspace, plus things a close later removes. */
function fullRecord(): LayoutViewRecord {
  return {
    ...emptyLayoutViewRecord(),
    activeTabId: 't1',
    activeWorktreeId: WS,
    activeTabIdByWorktree: { [WS]: 't1', other: 'x' },
    activeGroupIdByWorktree: { [WS]: 'g2' },
    activeFileIdByWorktree: { [WS]: '/repo/a.ts' },
    activeBrowserTabIdByWorktree: { [WS]: 'b1' },
    lastVisitedAtByWorktreeId: { [WS]: 5, [`local|${WS}`]: 6, other: 7 },
    groups: {
      [WS]: { g1: { activeTabId: 't2', recentTabIds: ['t1', 't2'] }, g2: { activeTabId: 't3' } }
    },
    lastFocusedAt: { [WS]: { t1: 1, t2: 2, t3: 3 } },
    panes: { t1: { activeLeafId: PANE_B, expandedLeafId: PANE_B } },
    editorDrafts: { [WS]: { '/repo/a.ts': { dirtyDraftContent: 'draft' } } }
  }
}

/** The workspace after t2 and pane B are closed and the browser tab and file are gone. */
function afterCloses(): WorkspaceLayout {
  const next = workspace()
  next.groups = [
    { id: 'g1', tabOrder: ['t1'] },
    { id: 'g2', tabOrder: ['t3'] }
  ]
  next.tabs = next.tabs.flatMap((tab): LayoutTab[] => {
    if (tab.id === 't2') {
      return []
    }
    return tab.kind === 'terminal'
      ? [{ ...tab, panes: { root: { type: 'leaf', leafId: PANE_A } } }]
      : [tab]
  })
  next.editorFiles = []
  next.browserTabs = []
  return next
}

describe('per-view store', () => {
  it('starts a view it has not seen empty, never from another view', () => {
    const store = setViewRecord({}, DESKTOP_VIEW_ID, fullRecord())

    expect(viewRecordOf(store, PHONE)).toEqual(emptyLayoutViewRecord())
    expect(viewRecordOf(store, DESKTOP_VIEW_ID)).toEqual(fullRecord())
  })

  it('keeps unsaved drafts for the desktop only', () => {
    const store = setViewRecord({}, PHONE, fullRecord())

    expect(viewRecordOf(store, PHONE).editorDrafts).toEqual({})
  })

  it('forgets a removed device and nothing else', () => {
    const store = setViewRecord(
      setViewRecord({}, PHONE, fullRecord()),
      DESKTOP_VIEW_ID,
      fullRecord()
    )

    expect(Object.keys(forgetView(store, PHONE))).toEqual([DESKTOP_VIEW_ID])
    expect(forgetView({}, PHONE)).toEqual({})
  })
})

describe('resolveWorkspaceSelection', () => {
  it('reads a record whose ids all exist as stored', () => {
    expect(resolveWorkspaceSelection(fullRecord(), WS, workspace())).toEqual({
      activeGroupId: 'g2',
      groups: {
        g1: { activeTabId: 't2', recentTabIds: ['t1', 't2'] },
        g2: { activeTabId: 't3', recentTabIds: [] }
      },
      panes: { t1: { activeLeafId: PANE_B, expandedLeafId: PANE_B } },
      activeFileId: '/repo/a.ts',
      activeBrowserTabId: 'b1'
    })
  })

  it('falls back for every id a close removed', () => {
    expect(resolveWorkspaceSelection(fullRecord(), WS, afterCloses())).toEqual({
      activeGroupId: 'g2',
      groups: {
        g1: { activeTabId: 't1', recentTabIds: ['t1'] },
        g2: { activeTabId: 't3', recentTabIds: [] }
      },
      panes: { t1: { activeLeafId: PANE_A, expandedLeafId: null } },
      activeFileId: null,
      activeBrowserTabId: null
    })
  })

  it('shows the most recent remaining tab, else the first, and the first group', () => {
    const record = emptyLayoutViewRecord()
    record.groups[WS] = { g1: { activeTabId: 'gone', recentTabIds: ['t2', 'gone'] } }

    const resolved = resolveWorkspaceSelection(record, WS, workspace())

    expect(resolved.activeGroupId).toBe('g1')
    expect(resolved.groups.g1?.activeTabId).toBe('t2')
    expect(resolved.groups.g2?.activeTabId).toBe('t3')
    expect(resolved.panes.t1).toEqual({ activeLeafId: PANE_A, expandedLeafId: null })
  })
})

describe('pruneViewRecord', () => {
  it('keeps a record whose ids all exist', () => {
    expect(pruneViewRecord(fullRecord(), model())).toEqual(fullRecord())
  })

  it('drops or resets what a close removed, and leaves other workspaces alone', () => {
    const pruned = pruneViewRecord(fullRecord(), model(afterCloses()))

    expect(pruned).toEqual({
      ...fullRecord(),
      activeTabIdByWorktree: { [WS]: 't1', other: 'x' },
      activeFileIdByWorktree: { [WS]: null },
      activeBrowserTabIdByWorktree: { [WS]: null },
      groups: {
        [WS]: { g1: { activeTabId: null, recentTabIds: ['t1'] }, g2: { activeTabId: 't3' } }
      },
      lastFocusedAt: { [WS]: { t1: 1, t3: 3 } },
      panes: { t1: { activeLeafId: PANE_A, expandedLeafId: null } },
      editorDrafts: { [WS]: {} }
    })
  })

  it('changes nothing the Serializer writes for the model', () => {
    const layout = model(afterCloses())
    const save = (desktopView: LayoutViewRecord) =>
      saveWorkspaceLayout({ ...asLoaded(layout), desktopView })
    const {
      activeFileIdByWorktree: _f,
      activeBrowserTabIdByWorktree: _b,
      ...pruned
    } = save(pruneViewRecord(fullRecord(), layout))
    const {
      activeFileIdByWorktree: _sf,
      activeBrowserTabIdByWorktree: _sb,
      ...stale
    } = save(fullRecord())

    expect(pruned).toEqual(stale)
  })
})

describe('removeWorkspaceFromView', () => {
  it('drops the workspace from every field the Store drops it from', () => {
    const removed = removeWorkspaceFromView(fullRecord(), WS, workspace())

    expect(removed).toEqual({
      ...emptyLayoutViewRecord(),
      activeTabIdByWorktree: { other: 'x' },
      activeGroupIdByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      lastVisitedAtByWorktreeId: { other: 7 }
    })
  })
})
