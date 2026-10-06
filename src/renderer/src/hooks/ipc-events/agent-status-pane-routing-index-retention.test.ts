import { describe, expect, it } from 'vitest'
import type { AppState } from '../../store/types'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  createAgentStatusPaneRoutingIndex,
  resolvePaneKeyFromRoutingIndex
} from './agent-status-pane-routing-index'

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo1::/remote/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

async function collectRetiredLayouts(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('agent-status routing layout lifetime', () => {
  it('releases replayed scrollback without another status event or tab replacement', async () => {
    const store = createTestStore()
    store.setState({
      repos: [{ ...TEST_REPO, connectionId: 'ssh-1' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: TEST_REPO.id })]
      },
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })] }
    })
    const tabs = store.getState().tabsByWorktree

    function replayAndReleaseLayout(): WeakRef<AppState['terminalLayoutsByTabId']> {
      store.getState().setTabLayout(TAB_ID, {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        titlesByLeafId: { [LEAF_ID]: 'Remote pane' },
        buffersByLeafId: { [LEAF_ID]: 'restored terminal output' }
      })
      const layouts = store.getState().terminalLayoutsByTabId
      const index = createAgentStatusPaneRoutingIndex(store.getState())
      expect(resolvePaneKeyFromRoutingIndex(index, makePaneKey(TAB_ID, LEAF_ID))).toMatchObject({
        title: 'Remote pane',
        repoConnectionId: 'ssh-1'
      })

      // Replay removes the stored buffer while preserving tab membership and pane identity.
      const releasedLayout = { ...layouts[TAB_ID] }
      delete releasedLayout.buffersByLeafId
      store.getState().setTabLayout(TAB_ID, releasedLayout)
      return new WeakRef(layouts)
    }

    const retired = replayAndReleaseLayout()
    expect(store.getState().tabsByWorktree).toBe(tabs)
    expect(store.getState().terminalLayoutsByTabId[TAB_ID].buffersByLeafId).toBeUndefined()
    await collectRetiredLayouts()

    expect(retired.deref()).toBeUndefined()
    const current = createAgentStatusPaneRoutingIndex(store.getState())
    expect(resolvePaneKeyFromRoutingIndex(current, makePaneKey(TAB_ID, LEAF_ID)).title).toBe(
      'Remote pane'
    )
  })

  it('keeps a same-source memo hit across collection and preserves held snapshots', async () => {
    const store = createTestStore()
    function rememberIndex() {
      return new WeakRef(createAgentStatusPaneRoutingIndex(store.getState()))
    }
    const remembered = rememberIndex()
    await collectRetiredLayouts()
    const previous = remembered.deref()
    expect(previous).toBeDefined()
    expect(createAgentStatusPaneRoutingIndex(store.getState())).toBe(previous)

    store.getState().setTabLayout(TAB_ID, {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null
    })
    const current = createAgentStatusPaneRoutingIndex(store.getState())
    expect(current).not.toBe(previous)
    expect(previous?.layoutsByTabId).toEqual({})
    expect(current.layoutsByTabId[TAB_ID].root).toEqual({ type: 'leaf', leafId: LEAF_ID })
  })
})
