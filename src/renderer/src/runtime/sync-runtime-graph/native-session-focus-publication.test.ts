import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncRuntimeGraph } from './graph-publication'
import { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } from './graph-sync-scheduler'
import { makeState } from './testing/sync-runtime-graph-test-harness'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

const WORKSPACE = 'folder:projects'
const tab = (
  id: string,
  entityId: string,
  contentType: Tab['contentType'] = 'agent-session'
): Tab => ({
  id,
  entityId,
  contentType,
  groupId: 'main',
  worktreeId: WORKSPACE,
  label: id,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})
afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('renderer native-session focus publication', () => {
  it('publishes exact chat changes and non-chat clearing in the same workspace without a terminal row', async () => {
    vi.useFakeTimers()
    const syncWindowGraph = vi.fn().mockResolvedValue({})
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const state = makeState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          tab('a', 'codex_A'),
          tab('b', 'claude_B'),
          tab('notes', '/notes.md', 'editor')
        ]
      },
      groupsByWorktree: {
        [WORKSPACE]: [
          { id: 'main', worktreeId: WORKSPACE, activeTabId: 'a', tabOrder: ['a', 'b', 'notes'] }
        ]
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'main' }
    })
    setRuntimeGraphStoreStateGetter(() => state)
    setRuntimeGraphSyncEnabled(true)
    await syncRuntimeGraph()
    state.groupsByWorktree[WORKSPACE]![0]!.activeTabId = 'b'
    await syncRuntimeGraph()
    state.groupsByWorktree[WORKSPACE]![0]!.activeTabId = 'notes'
    await syncRuntimeGraph()
    state.activeGroupIdByWorktree[WORKSPACE] = 'missing'
    await syncRuntimeGraph()
    expect(syncWindowGraph.mock.calls.map((call) => call[0].activeSessionIdsByWorkspace)).toEqual([
      { [WORKSPACE]: 'codex_A' },
      { [WORKSPACE]: 'claude_B' },
      { [WORKSPACE]: null },
      {}
    ])
  })
})
