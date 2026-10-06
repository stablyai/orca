// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { IDisposable } from '@xterm/xterm'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { installTerminalPaneHibernationWakeListener } from './terminal-pane-hibernation-wake-listener'

function dispatchWake(detail: WakeHibernatedAgentsWorktreeDetail): void {
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail
    })
  )
}

describe('installTerminalPaneHibernationWakeListener', () => {
  it('wakes the armed bindings of its own worktree on the dispatcher event and records their claims', () => {
    const armed = { dispose: vi.fn(), wakeHibernatedAgentIfArmed: vi.fn(() => 'claude:sess-1') }
    const idle = { dispose: vi.fn(), wakeHibernatedAgentIfArmed: vi.fn(() => null) }
    const plain: IDisposable = { dispose: vi.fn() }
    const panePtyBindingsRef = {
      current: new Map<number, IDisposable>([
        [1, armed],
        [2, idle],
        [3, plain]
      ])
    }
    const dispose = installTerminalPaneHibernationWakeListener({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      panePtyBindingsRef
    })

    const wokenClaimKeys = new Set<string>()
    dispatchWake({ worktreeId: 'wt-other', wokenClaimKeys })
    expect(armed.wakeHibernatedAgentIfArmed).not.toHaveBeenCalled()

    dispatchWake({ worktreeId: 'wt-1', tabIds: ['tab-other'], wokenClaimKeys })
    expect(armed.wakeHibernatedAgentIfArmed).not.toHaveBeenCalled()

    dispatchWake({ worktreeId: 'wt-1', wokenClaimKeys })
    expect(armed.wakeHibernatedAgentIfArmed).toHaveBeenCalledWith(wokenClaimKeys)
    expect(idle.wakeHibernatedAgentIfArmed).toHaveBeenCalledWith(wokenClaimKeys)
    expect([...wokenClaimKeys]).toEqual(['claude:sess-1'])

    dispose()
    dispatchWake({ worktreeId: 'wt-1', wokenClaimKeys })
    expect(armed.wakeHibernatedAgentIfArmed).toHaveBeenCalledTimes(1)
  })
})
