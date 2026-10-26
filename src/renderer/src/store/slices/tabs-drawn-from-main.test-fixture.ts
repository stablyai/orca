// With main layout ownership, emulate command replies and frames; install runtimeRpcClientWithLayoutApply/runtimeLayoutClientWithTestFrames mocks first. Inert for window-owned layouts.

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { _resetLayoutFramePositionForTests } from '@/runtime/layout-frame-position'
import { _resetPendingTabsForTests } from '@/runtime/layout-owner-pending-tabs'
import { _resetPendingTabFactsForTests } from '@/runtime/layout-owner-pending-tab-facts'
import { _resetContentRekeysForTests } from '@/runtime/layout-owner-content-rekeys'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import type { AppState } from '../types'

type DrawnStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
  subscribe: (listener: (state: AppState) => void) => () => void
}

export type TabsDrawnFromMain = {
  /** Resolves once main answered every command sent so far and its frames are drawn. */
  settle: () => Promise<void>
  close: () => void
}

const INERT: TabsDrawnFromMain = { settle: async () => {}, close: () => {} }

async function drain(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await layoutApplyTestTransport.settle()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Empty slices a frame build reads, for a partial test store (editor + tabs) that lacks them. */
const FRAME_SLICES: Partial<AppState> = {
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  lastKnownRelayPtyIdByTabId: {},
  terminalLayoutsByTabId: {},
  localOnlyScrollbackByTabId: {},
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  remoteBrowserPageHandlesByPageId: {},
  activeBrowserTabIdByWorktree: {},
  activeTabIdByWorktree: {},
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  layoutByWorktree: {},
  activeGroupIdByWorktree: {},
  browserUrlHistory: [],
  sshConnectionStates: new Map()
}

function missingFrameSlices(state: AppState): Partial<AppState> {
  return Object.fromEntries(Object.entries(FRAME_SLICES).filter(([key]) => !(key in state)))
}

/** Main takes the store's current layout and draws it from here on; a no-op with the switch off. */
export async function drawTabsFromMain(store: DrawnStore): Promise<TabsDrawnFromMain> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return INERT
  }
  layoutApplyTestTransport.reset()
  _resetLayoutFramePositionForTests()
  _resetPendingTabsForTests()
  _resetPendingTabFactsForTests()
  _resetContentRekeysForTests()
  layoutApplyTestTransport.answerWith('apply')
  store.setState(missingFrameSlices(store.getState()))
  layoutApplyTestTransport.useMainModel(
    loadMainLayoutModel('local', buildWorkspaceSessionPayload(store.getState()))
  )
  const frames = openWorkspaceLayoutFrameSync(store)
  frames.start()
  await drain()
  return {
    settle: drain,
    close: () => {
      frames.close()
      layoutApplyTestTransport.reset()
    }
  }
}
