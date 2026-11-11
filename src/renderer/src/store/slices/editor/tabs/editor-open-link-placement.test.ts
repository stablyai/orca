import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '../editor-slice-test-harness'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { captureEditorOpenLinkIntent } from './editor-open-target-group'
import { removeGroupLayoutLeaf } from '../../../../../../shared/workspace-layout/tab-group-layout-tree'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { makeLayout, makeTab } from '../../../terminals/terminal-tab.test-fixture'
import { drawTabsFromMain } from '../../tabs/tabs-drawn-from-main.test-fixture'

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
  // A terminal with its row, so main holds it once it takes the layout.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && contentType === 'terminal') {
    const state = store.getState()
    store.setState({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'wt-1': [
          ...(state.tabsByWorktree['wt-1'] ?? []),
          makeTab({ id: `${id}-entity`, worktreeId: 'wt-1' })
        ]
      },
      terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId, [`${id}-entity`]: makeLayout() }
    })
  }
}

/** A seeded editor; a layout-owner build lays it out as a restore does, before main takes it. */
function addEditor(store: StoreApi<AppState>, filePath: string, groupId: string): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    store.getState().openFile(fileInput(filePath), { targetGroupId: groupId })
    return
  }
  store.setState({
    openFiles: [
      ...store.getState().openFiles,
      { ...fileInput(filePath), id: filePath, isDirty: false }
    ]
  })
  store.getState().createUnifiedTab('wt-1', 'editor', {
    entityId: filePath,
    label: filePath,
    targetGroupId: groupId
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
  it('follows a source tab that moved to another group while its old group survives', async () => {
    const store = createEditorTabsStore()
    const { a, b, c } = seedColumns(store, 'terminal', 'terminal', 'terminal')
    addTab(store, 'terminal', 'keeps-a-alive', a)
    const main = await drawTabsFromMain(store)
    const intent = linkIntent(store)
    store.getState().moveUnifiedTabToGroup(intent!.sourceTabId, b)

    store.getState().openFileForLink(fileInput('/repo/link.ts'), {}, intent)
    await main.settle()
    main.close()

    // From B the preferred neighbor is C; a stale source in A would choose B.
    expect(groupOfFile(store, '/repo/link.ts')).toEqual([c])
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
})
