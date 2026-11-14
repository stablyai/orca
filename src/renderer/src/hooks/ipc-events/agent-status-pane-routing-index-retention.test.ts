import { describe, expect, it } from 'vitest'
import type { AppState } from '../../store/types'
import { createTestStore } from '../../store/testing/app-store-test-fixture'
import { makeTab } from '../../store/terminals/testing/terminal-tab.test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../store/repos/repo.test-fixture'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  createAgentStatusPaneRoutingIndex,
  resolvePaneKeyFromRoutingIndex
} from './agent-status-pane-routing-index'

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo1::/remote/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

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

    replayAndReleaseLayout()

    expect(store.getState().terminalLayoutsByTabId[TAB_ID].buffersByLeafId).toBeUndefined()

    const current = createAgentStatusPaneRoutingIndex(store.getState())
    expect(resolvePaneKeyFromRoutingIndex(current, makePaneKey(TAB_ID, LEAF_ID)).title).toBe(
      'Remote pane'
    )
  })
})
