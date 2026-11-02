import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type { ProgramStatusFacet } from '../../../shared/program-status/facet'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

export const WT = 'repo1::/path/wt1'
export const ENV = 'remote-env-1'
export const T0 = 1_700_000_000_000
export const HOST_TAB_ID = 'host-tab-1'
export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)
export const PANE_KEY = makePaneKey(MIRROR_TAB_ID, LEAF_ID)
export const FACET: ProgramStatusFacet = { state: 'working', progress: 40, observedAt: T0 }

export function hostSnapshot(
  snapshotVersion: number,
  programStatus?: ProgramStatusFacet
): RuntimeMobileSessionTabsResult & { tabs: RuntimeMobileSessionTerminalClientTab[] } {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: '',
          updatedAt: T0 - 1_000,
          stateStartedAt: T0 - 2_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: WT,
          stateHistory: [],
          ...(programStatus ? { programStatus } : {})
        }
      }
    ]
  }
}
