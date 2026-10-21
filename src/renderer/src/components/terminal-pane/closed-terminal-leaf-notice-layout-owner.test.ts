import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { applyClosedTerminalLeafNotice } from './closed-terminal-leaf-notice'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  hasTerminalPaneSplitMountLease,
  queueTerminalPaneSplitRequest,
  takeQueuedTerminalPaneSplitRequests
} from './terminal-pane-split-request-routing'

afterEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
  vi.unstubAllGlobals()
})

describe('a pane main closed while its split waited for the tab to mount', () => {
  it('drops the waiting split, so the tab mounts without the closed pane', () => {
    vi.stubGlobal('window', new EventTarget())
    queueTerminalPaneSplitRequest({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneRuntimeId: 1,
      sourceLeafId: '11111111-1111-4111-8111-111111111111',
      direction: 'vertical',
      newLeafId: '22222222-2222-4222-8222-222222222222',
      command: 'make test'
    })

    applyClosedTerminalLeafNotice('tab-1', '22222222-2222-4222-8222-222222222222')

    expect(takeQueuedTerminalPaneSplitRequests('tab-1', 'wt-1')).toEqual([])
    expect(hasTerminalPaneSplitMountLease('tab-1')).toBe(false)
  })
})
