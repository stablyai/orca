import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createTestStore, makeTab, seedStore } from '@/store/slices/store-test-helpers'
import { transferExistingPtyAgentPaneAuthority } from './terminal-split-existing-pty-authority'

const WORKTREE_ID = 'folder:split-authority'
const SOURCE_TAB_ID = 'tab-source'
const TARGET_TAB_ID = 'tab-target'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const PTY_ID = 'pty-existing'

function createAuthorityStore() {
  const store = createTestStore()
  seedStore(store, {
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: SOURCE_TAB_ID, worktreeId: WORKTREE_ID, ptyId: PTY_ID }),
        makeTab({ id: TARGET_TAB_ID, worktreeId: WORKTREE_ID, ptyId: PTY_ID })
      ]
    },
    terminalLayoutsByTabId: {
      [SOURCE_TAB_ID]: {
        root: { type: 'leaf', leafId: SOURCE_LEAF_ID },
        activeLeafId: SOURCE_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SOURCE_LEAF_ID]: PTY_ID }
      },
      [TARGET_TAB_ID]: {
        root: { type: 'leaf', leafId: TARGET_LEAF_ID },
        activeLeafId: TARGET_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TARGET_LEAF_ID]: PTY_ID }
      }
    },
    ptyIdsByTabId: {
      [SOURCE_TAB_ID]: [PTY_ID],
      [TARGET_TAB_ID]: [PTY_ID]
    }
  })
  return store
}

describe('existing PTY split agent authority', () => {
  it('keeps a completed resumable agent after the original tab retires', () => {
    const store = createAuthorityStore()
    const sourcePaneKey = makePaneKey(SOURCE_TAB_ID, SOURCE_LEAF_ID)
    const targetPaneKey = makePaneKey(TARGET_TAB_ID, TARGET_LEAF_ID)
    const providerSession = { key: 'session_id' as const, id: 'codex-session' }
    store
      .getState()
      .setAgentStatus(
        sourcePaneKey,
        { state: 'done', prompt: 'phase one', agentType: 'codex' },
        'Codex',
        undefined,
        { tabId: SOURCE_TAB_ID, worktreeId: WORKTREE_ID },
        { providerSession }
      )

    expect(
      transferExistingPtyAgentPaneAuthority({
        state: store.getState(),
        worktreeId: WORKTREE_ID,
        tabId: TARGET_TAB_ID,
        leafId: TARGET_LEAF_ID,
        ptyId: PTY_ID
      })
    ).toBe(true)
    store.getState().closeTab(SOURCE_TAB_ID, {
      captureRecentlyClosed: false,
      localPtyTeardownOwnedExternally: true
    })

    expect(store.getState().agentStatusByPaneKey[sourcePaneKey]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[targetPaneKey]).toMatchObject({
      paneKey: targetPaneKey,
      tabId: TARGET_TAB_ID,
      state: 'done',
      agentType: 'codex',
      providerSession
    })
  })

  it('does not guess when two source leaves claim the existing PTY', () => {
    const store = createAuthorityStore()
    store.setState({
      terminalLayoutsByTabId: {
        ...store.getState().terminalLayoutsByTabId,
        'tab-other': {
          root: { type: 'leaf', leafId: OTHER_LEAF_ID },
          activeLeafId: OTHER_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [OTHER_LEAF_ID]: PTY_ID }
        }
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          ...(store.getState().tabsByWorktree[WORKTREE_ID] ?? []),
          makeTab({ id: 'tab-other', worktreeId: WORKTREE_ID, ptyId: PTY_ID })
        ]
      }
    })

    expect(
      transferExistingPtyAgentPaneAuthority({
        state: store.getState(),
        worktreeId: WORKTREE_ID,
        tabId: TARGET_TAB_ID,
        leafId: TARGET_LEAF_ID,
        ptyId: PTY_ID
      })
    ).toBe(false)
  })
})
