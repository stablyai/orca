import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import type { AppState } from '../types'
import type { OpenFile } from './editor/types/open-file'
import { captureEditorOpenLinkIntent } from './editor/tabs/editor-open-target-group'
import { removeGroupLayoutLeaf } from '../../../../shared/workspace-layout/tab-group-layout-tree'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function fileInput(filePath: string, worktreeId = 'wt-1'): Omit<OpenFile, 'id' | 'isDirty'> {
  return {
    filePath,
    relativePath: filePath.replace('/repo/', ''),
    worktreeId,
    language: 'typescript',
    mode: 'edit'
  }
}

function splitRight(store: StoreApi<AppState>, groupId: string): string {
  const created = store.getState().createEmptySplitGroup('wt-1', groupId, 'right')
  if (!created) {
    throw new Error('Expected split group')
  }
  return created
}

function addTab(
  store: StoreApi<AppState>,
  contentType: 'terminal' | 'agent-session',
  id: string,
  groupId?: string
): void {
  store.getState().createUnifiedTab('wt-1', contentType, {
    id,
    entityId: `${id}-entity`,
    label: id,
    ...(groupId ? { targetGroupId: groupId } : {})
  })
}

function addEditor(store: StoreApi<AppState>, filePath: string, groupId: string): void {
  store.getState().openFile(fileInput(filePath), { targetGroupId: groupId })
}

/** Drops a tab the way a close would, without the terminal slice the harness lacks. */
function removeTab(store: StoreApi<AppState>, tabId: string): void {
  const state = store.getState()
  store.setState({
    unifiedTabsByWorktree: {
      'wt-1': state.unifiedTabsByWorktree['wt-1']!.filter((tab) => tab.id !== tabId)
    },
    groupsByWorktree: {
      'wt-1': state.groupsByWorktree['wt-1']!.map((group) => {
        const tabOrder = group.tabOrder.filter((id) => id !== tabId)
        return { ...group, tabOrder, activeTabId: tabOrder.at(-1) ?? null }
      })
    }
  })
}

function removeGroup(store: StoreApi<AppState>, groupId: string): void {
  const state = store.getState()
  store.setState({
    groupsByWorktree: {
      'wt-1': state.groupsByWorktree['wt-1']!.filter((group) => group.id !== groupId)
    },
    layoutByWorktree: {
      'wt-1': removeGroupLayoutLeaf(state.layoutByWorktree['wt-1']!, groupId)!
    }
  })
}

function focus(store: StoreApi<AppState>, groupId: string): void {
  store.setState({ activeGroupIdByWorktree: { 'wt-1': groupId } })
}

function groupOfFile(store: StoreApi<AppState>, filePath: string): string[] {
  return (store.getState().unifiedTabsByWorktree['wt-1'] ?? [])
    .filter((tab) => tab.entityId === filePath)
    .map((tab) => tab.groupId)
}

/** Three columns A–B–C with the source tab in A. */
function seedColumns(
  store: StoreApi<AppState>,
  source: 'terminal' | 'agent-session',
  middle: 'terminal' | 'editor',
  right: 'terminal' | 'editor'
): { a: string; b: string; c: string } {
  addTab(store, source, 'source')
  const a = store.getState().groupsByWorktree['wt-1']![0]!.id
  const b = splitRight(store, a)
  const c = splitRight(store, b)
  for (const [groupId, kind] of [
    [b, middle],
    [c, right]
  ] as const) {
    if (kind === 'editor') {
      addEditor(store, `/repo/${groupId}-seed.ts`, groupId)
    } else {
      addTab(store, 'terminal', `${groupId}-terminal`, groupId)
    }
  }
  focus(store, a)
  return { a, b, c }
}

function linkIntent(store: StoreApi<AppState>, explicit = false) {
  return captureEditorOpenLinkIntent(store.getState(), 'wt-1', 'source', {
    explicitSourceGroup: explicit
  })
}

describe('file links open beside their source', () => {
  it('captures the source only within the workspace that owns the link', () => {
    const store = createEditorTabsStore()
    store.getState().createUnifiedTab('wt-2', 'terminal', { id: 'source' })
    addTab(store, 'terminal', 'source')

    expect(linkIntent(store)?.workspaceId).toBe('wt-1')
    expect(captureEditorOpenLinkIntent(store.getState(), 'missing', 'source')).toBeNull()
  })

  it('moves a native-chat link from the chat group to the neighboring editor', () => {
    const store = createEditorTabsStore()
    addTab(store, 'agent-session', 'source')
    const a = store.getState().groupsByWorktree['wt-1']![0]!.id
    const b = splitRight(store, a)
    addEditor(store, '/repo/seed.ts', b)
    focus(store, a)

    store.getState().openFile(fileInput('/repo/plain.ts'))
    const opened = store
      .getState()
      .openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store))

    // Why: the plain open documents the unchanged baseline for callers without link intent.
    expect(groupOfFile(store, '/repo/plain.ts')).toEqual([a])
    expect(groupOfFile(store, '/repo/link.ts')).toEqual([b])
    expect(opened).toMatchObject({ fileId: '/repo/link.ts', groupId: b })
  })

  it('covers the adjacent terminal instead of jumping to a nonadjacent editor', () => {
    const store = createEditorTabsStore()
    const { a, b, c } = seedColumns(store, 'terminal', 'terminal', 'editor')

    store.getState().openFile(fileInput('/repo/plain.ts'))
    focus(store, a)
    store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store))

    expect(groupOfFile(store, '/repo/plain.ts')).toEqual([c])
    expect(groupOfFile(store, '/repo/link.ts')).toEqual([b])
  })

  it('selects an existing unselected view of the file over a nearby editor', () => {
    const store = createEditorTabsStore()
    const { a, b, c } = seedColumns(store, 'terminal', 'editor', 'terminal')
    addEditor(store, '/repo/link.ts', c)
    store.getState().activateTab(`${c}-terminal`)
    focus(store, a)
    const existing = store
      .getState()
      .unifiedTabsByWorktree['wt-1']!.find((tab) => tab.entityId === '/repo/link.ts')!

    const opened = store
      .getState()
      .openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store))

    expect(groupOfFile(store, '/repo/link.ts')).toEqual([c])
    expect(opened).toEqual({ fileId: '/repo/link.ts', viewStateId: existing.id, groupId: c })
    expect(store.getState().groupsByWorktree['wt-1']!.find((g) => g.id === c)?.activeTabId).toBe(
      existing.id
    )
    expect(b).not.toBe(c)
  })

  it('opens a second view in the neighbor when only the source holds the file', () => {
    const store = createEditorTabsStore()
    const { a, b } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    addEditor(store, '/repo/link.ts', a)
    store.getState().activateTab('source')

    const opened = store
      .getState()
      .openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store))

    expect(groupOfFile(store, '/repo/link.ts').sort()).toEqual([a, b].sort())
    expect(store.getState().openFiles.filter((f) => f.filePath === '/repo/link.ts')).toHaveLength(1)
    expect(opened?.groupId).toBe(b)
  })

  it('keeps placement on the captured source when focus moves during resolution', () => {
    const store = createEditorTabsStore()
    const { b, c } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    const intent = linkIntent(store)
    focus(store, c)

    store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, intent)

    expect(groupOfFile(store, '/repo/link.ts')).toEqual([b])
  })

  it('follows a source tab that moved to another group while its old group survives', () => {
    const store = createEditorTabsStore()
    const { a, b, c } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    addTab(store, 'terminal', 'keeps-a-alive', a)
    const intent = linkIntent(store)
    store.getState().moveUnifiedTabToGroup(intent!.sourceTabId, b)

    store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, intent)

    // From B the preferred neighbor is C; a stale source in A would choose B.
    expect(groupOfFile(store, '/repo/link.ts')).toEqual([c])
  })

  it('uses default placement once the source tab has closed', () => {
    const store = createEditorTabsStore()
    const { a, c } = seedColumns(store, 'terminal', 'terminal', 'editor')
    addTab(store, 'terminal', 'keeps-a-alive', a)
    const intent = linkIntent(store)
    removeTab(store, intent!.sourceTabId)
    focus(store, a)

    store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, intent)

    // The focused terminal's existing preference sends the file to the visible editor.
    expect(groupOfFile(store, '/repo/link.ts')).toEqual([c])
  })

  it('uses destination defaults when resolution routes to another workspace', () => {
    const store = createEditorTabsStore()
    seedColumns(store, 'terminal', 'terminal', 'terminal')

    const opened = store
      .getState()
      .openFileForLink(fileInput('/other/link.ts', 'wt-2'), {}, linkIntent(store))

    expect(opened?.groupId).toBe(store.getState().groupsByWorktree['wt-2']?.[0]?.id)
  })

  it('pins an explicit request to the captured group even when another group has the file', () => {
    const store = createEditorTabsStore()
    const { a, c } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    addEditor(store, '/repo/link.ts', c)
    store.getState().activateTab('source')

    const opened = store
      .getState()
      .openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store, true))

    expect(opened?.groupId).toBe(a)
    expect(groupOfFile(store, '/repo/link.ts').sort()).toEqual([a, c].sort())
  })

  it('refuses an explicit request whose group closed, without touching editor state', () => {
    const store = createEditorTabsStore()
    const { b } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    store.getState().activateTab(`${b}-terminal`)
    const intent = captureEditorOpenLinkIntent(store.getState(), 'wt-1', `${b}-terminal`, {
      explicitSourceGroup: true
    })
    removeGroup(store, b)
    const before = store.getState().openFiles

    const opened = store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, intent)

    expect(opened).toBeNull()
    expect(store.getState().openFiles).toBe(before)
    expect(store.getState().groupsByWorktree['wt-1']!.some((g) => g.id === b)).toBe(false)
  })

  it('refuses when the chosen group disappears at the mutation seam', () => {
    const store = createEditorTabsStore()
    const { b } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    const intent = linkIntent(store)
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.openFiles !== previous.openFiles) {
        unsubscribe()
        removeGroup(store, b)
      }
    })

    const opened = store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, intent)

    expect(opened).toBeNull()
    expect(groupOfFile(store, '/repo/link.ts')).toEqual([])
    expect(store.getState().groupsByWorktree['wt-1']!.some((g) => g.id === b)).toBe(false)
  })

  it('returns the created view and focuses it', () => {
    const store = createEditorTabsStore()
    const { b } = seedColumns(store, 'terminal', 'terminal', 'terminal')

    const opened = store
      .getState()
      .openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store))
    const view = store
      .getState()
      .unifiedTabsByWorktree['wt-1']!.find((tab) => tab.entityId === '/repo/link.ts')

    expect(opened).toEqual({ fileId: '/repo/link.ts', viewStateId: view?.id, groupId: b })
    expect(store.getState().activeGroupIdByWorktree['wt-1']).toBe(b)
    expect(store.getState().pendingEditorFocusRequest).toMatchObject({
      fileId: '/repo/link.ts',
      viewStateId: view?.id
    })
  })

  it('keeps the source in place when it is the only group', () => {
    const store = createEditorTabsStore()
    addTab(store, 'terminal', 'source')
    const a = store.getState().groupsByWorktree['wt-1']![0]!.id

    const opened = store
      .getState()
      .openFileForLink(fileInput('/repo/link.ts'), {}, linkIntent(store))

    expect(opened?.groupId).toBe(a)
    expect(store.getState().groupsByWorktree['wt-1']).toHaveLength(1)
  })
})
