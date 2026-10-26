import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { applyClosedTerminalLeafNotice } from './closed-terminal-leaf-notice'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  hasTerminalPaneSplitMountLease,
  takeQueuedTerminalPaneSplitRequests
} from './terminal-pane-split-request-routing'

afterEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
  vi.unstubAllGlobals()
})

describe('a pane main closed before its tab mounted, in a layout-owner build', () => {
  // Main-owned splits mount from frames; once main removes the leaf, no window-side deferred mount may remain.
  it('leaves nothing waiting to mount it, and drops it from a mounted tab as before', () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const closed = vi.fn()
    target.addEventListener(CLOSE_TERMINAL_PANE_EVENT, (event) => {
      if (event instanceof CustomEvent) {
        closed(event.detail)
      }
    })

    applyClosedTerminalLeafNotice('tab-1', '22222222-2222-4222-8222-222222222222')

    expect(takeQueuedTerminalPaneSplitRequests('tab-1', 'wt-1')).toEqual([])
    expect(hasTerminalPaneSplitMountLease('tab-1')).toBe(false)
    expect(closed).toHaveBeenCalledWith({
      tabId: 'tab-1',
      leafId: '22222222-2222-4222-8222-222222222222'
    })
  })
})
