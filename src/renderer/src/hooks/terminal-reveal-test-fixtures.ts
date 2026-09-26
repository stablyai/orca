import { createHarnessStoreState, type HarnessStoreState } from './ipc-events-harness-store-state'

export const OWNER_ELSEWHERE_EVENT_WORKTREE_ID = 'wt-1'
export const OWNER_ELSEWHERE_OWNER_WORKTREE_ID = 'wt-other'

/**
 * A store whose pty is owned by a row filed under a worktree key other than the reveal event's —
 * the shape that licensed the STA-7961 duplicate. Overrides replace a whole top-level key.
 */
export function createStoreWithOwnerFiledElsewhere(
  overrides: Partial<HarnessStoreState> = {}
): HarnessStoreState {
  return createHarnessStoreState({
    tabsByWorktree: {
      [OWNER_ELSEWHERE_EVENT_WORKTREE_ID]: [
        { id: 'tab-other', ptyId: 'pty-other', title: 'Terminal 3' }
      ],
      [OWNER_ELSEWHERE_OWNER_WORKTREE_ID]: [{ id: 'tab-a', ptyId: 'pty-a', title: 'Terminal 1' }]
    },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
      }
    },
    ...overrides
  })
}
