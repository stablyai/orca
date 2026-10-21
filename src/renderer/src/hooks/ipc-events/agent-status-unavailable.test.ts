import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusClearIpcPayload } from '../../../../shared/agent-status-types'
import { registerAgentStatusListeners } from './agent-status-listeners'

const store = vi.hoisted(() => ({
  agentStatusByPaneKey: { pane: { state: 'done' } },
  removeAgentStatus: vi.fn()
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('host-selected status unavailable', () => {
  it('removes a completed projection only for an explicit unavailable or program-removal clear', () => {
    let clear: ((event: AgentStatusClearIpcPayload) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        agentStatus: {
          onSet: () => () => {},
          onClear: (callback: typeof clear) => {
            clear = callback
            return () => {}
          }
        }
      }
    })
    registerAgentStatusListeners({
      unsubs: [],
      enqueueLiveAgentStatus: vi.fn(),
      drainQueuedLiveAgentStatusesForPane: vi.fn(),
      pendingAgentStatusEvents: [],
      transientClearWatermarkByConnectionId: new Map(),
      liveAgentStatusBurstQueue: []
    })
    clear?.({ paneKey: 'pane' })
    expect(store.removeAgentStatus).not.toHaveBeenCalled()
    clear?.({ paneKey: 'pane', statusUnavailable: true })
    expect(store.removeAgentStatus).toHaveBeenCalledWith('pane')
    store.removeAgentStatus.mockClear()
    clear?.({ paneKey: 'pane', programStatusRemoved: true })
    expect(store.removeAgentStatus).toHaveBeenCalledWith('pane')
  })
})
