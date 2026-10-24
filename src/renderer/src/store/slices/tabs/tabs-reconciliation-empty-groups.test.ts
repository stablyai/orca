import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { captureEditorOpenLinkIntent } from '../editor/tabs/editor-open-target-group'
import { drawTabsFromMain } from '../tabs-drawn-from-main.test-fixture'

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

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

function seedSource(
  store: ReturnType<typeof createTestStore>,
  workspaceId: string,
  source: 'terminal' | 'agent-session'
): void {
  store.getState().createUnifiedTab(workspaceId, source, { id: 'source', entityId: 'source' })
  if (source === 'terminal') {
    store.setState({
      tabsByWorktree: {
        [workspaceId]: [makeTab({ id: 'source', worktreeId: workspaceId, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { source: ['pty-1'] }
    })
  }
}

function splitBesideSource(store: ReturnType<typeof createTestStore>, workspaceId: string) {
  const sourceGroupId = store.getState().groupsByWorktree[workspaceId][0].id
  const emptyGroupId = store.getState().createEmptySplitGroup(workspaceId, sourceGroupId, 'right')
  if (!emptyGroupId) {
    throw new Error('Expected an empty split group')
  }
  return { store, sourceGroupId, emptyGroupId }
}

function splitWorkspace(workspaceId: string, source: 'terminal' | 'agent-session' = 'terminal') {
  const store = createTestStore()
  seedSource(store, workspaceId, source)
  return splitBesideSource(store, workspaceId)
}

/** As splitWorkspace, with main holding the source tab and drawing the store from its frames. */
async function drawnSplitWorkspace(workspaceId: string, source: 'terminal' | 'agent-session') {
  const store = createTestStore()
  seedSource(store, workspaceId, source)
  const main = await drawTabsFromMain(store)
  return { ...splitBesideSource(store, workspaceId), main }
}

describe.each(['repo1::/tmp/feature', 'folder:folder-1'])('empty groups in %s', (workspaceId) => {
  it.each(['terminal', 'agent-session'] as const)(
    'preserves an empty neighbor through reconciliation before opening a %s link',
    async (source) => {
      const { store, sourceGroupId, emptyGroupId, main } = await drawnSplitWorkspace(
        workspaceId,
        source
      )
      const before = store.getState()
      const intent = captureEditorOpenLinkIntent(before, workspaceId, 'source')
      expect(intent).not.toBeNull()
      expect(before.activeGroupIdByWorktree[workspaceId]).toBe(emptyGroupId)

      for (let pass = 0; pass < 2; pass++) {
        expect(store.getState().reconcileWorktreeTabModel(workspaceId).renderableTabCount).toBe(1)
        const state = store.getState()
        expect(state.groupsByWorktree[workspaceId]).toBe(before.groupsByWorktree[workspaceId])
        expect(state.layoutByWorktree[workspaceId]).toBe(before.layoutByWorktree[workspaceId])
        expect(state.activeGroupIdByWorktree[workspaceId]).toBe(emptyGroupId)
      }

      const opened = store.getState().openFileForLink(
        {
          filePath: '/tmp/feature/link.ts',
          relativePath: 'link.ts',
          worktreeId: workspaceId,
          language: 'typescript',
          mode: 'edit'
        },
        {},
        intent
      )

      expect(opened?.groupId).toBe(emptyGroupId)
      // A layout-owner build draws the opened tab in that group once main's frame is in.
      await main.settle()
      main.close()
      const state = store.getState()
      expect(state.unifiedTabsByWorktree[workspaceId]).toContainEqual(
        expect.objectContaining({ id: opened?.viewStateId, groupId: emptyGroupId })
      )
      expect(
        state.groupsByWorktree[workspaceId].find((group) => group.id === sourceGroupId)
      ).toMatchObject({ activeTabId: 'source', tabOrder: ['source'] })
    }
  )

  it('removes a group emptied by stale-tab cleanup while preserving an already empty group', () => {
    const { store, sourceGroupId, emptyGroupId } = splitWorkspace(workspaceId)
    const layoutWithEmptyNeighbor = store.getState().layoutByWorktree[workspaceId]
    const staleGroupId = store.getState().createEmptySplitGroup(workspaceId, emptyGroupId, 'right')
    if (!staleGroupId) {
      throw new Error('Expected a stale split group')
    }
    store.getState().createUnifiedTab(workspaceId, 'browser', {
      id: 'stale-browser',
      entityId: 'missing-browser',
      targetGroupId: staleGroupId
    })

    store.getState().reconcileWorktreeTabModel(workspaceId)

    const state = store.getState()
    expect(state.groupsByWorktree[workspaceId].map((group) => group.id)).toEqual([
      sourceGroupId,
      emptyGroupId
    ])
    expect(state.layoutByWorktree[workspaceId]).toEqual(layoutWithEmptyNeighbor)
    expect(state.activeGroupIdByWorktree[workspaceId]).toBe(sourceGroupId)
    expect(state.unifiedTabsByWorktree[workspaceId].map((tab) => tab.id)).toEqual(['source'])
  })
})
