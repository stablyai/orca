import { afterEach, expect, it, vi } from 'vitest'
import { registerAgentStatusListeners } from './agent-status-listeners'
import { noteTerminalWorkerRestartOffers } from '../../../components/native-chat-recovery/offers/native-chat-resume-on-restart-store'

vi.mock(
  '../../../components/native-chat-recovery/offers/native-chat-resume-on-restart-store',
  () => ({
    noteTerminalWorkerRestartOffers: vi.fn()
  })
)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(noteTerminalWorkerRestartOffers).mockClear()
})

it.each([true, false])(
  'shows terminal workers offered before this window listened only when some wait (%s)',
  async (offered) => {
    vi.stubGlobal('window', {
      api: {
        agentStatus: {
          onSet: () => () => {},
          onClear: () => () => {},
          onRestartOffersChanged: () => () => {},
          hasRestartOffers: async () => offered
        }
      }
    })
    registerAgentStatusListeners({
      unsubs: [],
      enqueueLiveAgentStatus: () => {},
      drainQueuedLiveAgentStatusesForPane: () => {},
      pendingAgentStatusEvents: [],
      liveAgentStatusBurstQueue: [],
      transientClearWatermarkByConnectionId: new Map()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(noteTerminalWorkerRestartOffers).toHaveBeenCalledTimes(offered ? 1 : 0)
  }
)
