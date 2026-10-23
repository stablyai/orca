import { beforeEach, describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import { createEditorTabsStore } from './editor-slice-test-harness'

const WT = 'repo1::/tmp/feature'

function openPreview(store: StoreApi<AppState>, name: string): void {
  store.getState().openFile(
    {
      filePath: `/repo/${name}.ts`,
      relativePath: `${name}.ts`,
      worktreeId: WT,
      language: 'typescript',
      mode: 'edit'
    },
    { preview: true }
  )
}

describe('preview state when the second pane opens beside the first', () => {
  let store: StoreApi<AppState>

  beforeEach(() => {
    store = createEditorTabsStore()
  })

  it('keeps the left preview and its backing file when the next preview splits', () => {
    openPreview(store, 'a')
    openPreview(store, 'b')

    const state = store.getState()
    expect(state.groupsByWorktree[WT]).toHaveLength(2)
    // Why: the redirect means a.ts was not replaced, so its OpenFile must survive.
    expect(state.openFiles.filter((file) => file.worktreeId === WT)).toHaveLength(2)
    const tabs = state.unifiedTabsByWorktree[WT] ?? []
    const left = tabs.find((tab) => tab.entityId?.includes('a.ts'))
    const right = tabs.find((tab) => tab.entityId?.includes('b.ts'))
    expect(left).toBeTruthy()
    expect(right).toBeTruthy()
    expect(left?.groupId).not.toBe(right?.groupId)
    for (const tab of tabs) {
      expect(state.openFiles.some((file) => file.id === tab.entityId)).toBe(true)
    }
    // Nothing was closed, so nothing belongs on the recently-closed stack.
    expect(state.recentlyClosedEditorTabsByWorktree?.[WT] ?? []).toHaveLength(0)
  })

  it('once split in two content panes, replaces the preview opposite the focused pane', () => {
    for (const name of ['a', 'b', 'c']) {
      openPreview(store, name)
    }

    const state = store.getState()
    expect(state.groupsByWorktree[WT]).toHaveLength(2)
    const tabs = state.unifiedTabsByWorktree[WT] ?? []
    // b.ts took focus on the right, so c.ts replaced a.ts on the left.
    expect(tabs.some((tab) => tab.entityId?.includes('a.ts'))).toBe(false)
    expect(tabs.some((tab) => tab.entityId?.includes('b.ts'))).toBe(true)
    expect(tabs.some((tab) => tab.entityId?.includes('c.ts'))).toBe(true)
    for (const tab of tabs) {
      expect(state.openFiles.some((file) => file.id === tab.entityId)).toBe(true)
    }
  })
})
