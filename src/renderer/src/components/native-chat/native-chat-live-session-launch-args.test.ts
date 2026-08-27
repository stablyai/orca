import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../../store/slices/store-test-helpers'
import type { AppState } from '../../store/types'
import { resolveNativeChatLiveSessionLaunchArgs } from './native-chat-live-session-launch-args'

let testStore: ReturnType<typeof createTestStore>

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore.getState()
  }
}))

const PANE_KEY = 'tab-1:leaf-1'

const TERMINAL_HANDLE = 'th-1'

function seedStatusEntry(): void {
  testStore.setState({
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        agentType: 'claude',
        state: 'working',
        prompt: '',
        updatedAt: 0,
        stateStartedAt: 0,
        stateHistory: [],
        // Why: getAgentLaunchConfigForStatusEntry always sends launchToken:
        // undefined, so a matching terminalHandle is the identity proof here.
        terminalHandle: TERMINAL_HANDLE
      }
    }
  } as Partial<AppState>)
}

describe('resolveNativeChatLiveSessionLaunchArgs', () => {
  beforeEach(() => {
    testStore = createTestStore()
  })

  it('surfaces the pane launch config agent args, proving they reach the hook layer', () => {
    testStore
      .getState()
      .registerAgentLaunchConfig(
        PANE_KEY,
        { agentArgs: '--dangerously-skip-permissions', agentEnv: {} },
        { agentType: 'claude', terminalHandle: TERMINAL_HANDLE }
      )
    seedStatusEntry()

    expect(resolveNativeChatLiveSessionLaunchArgs(PANE_KEY)).toEqual({
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })
  })

  it('returns undefined args when the pane has no live status entry yet', () => {
    expect(resolveNativeChatLiveSessionLaunchArgs(PANE_KEY)).toEqual({
      agentArgs: undefined,
      agentEnv: undefined
    })
  })

  it('returns undefined args when no launch config was ever registered for the pane', () => {
    seedStatusEntry()
    expect(resolveNativeChatLiveSessionLaunchArgs(PANE_KEY)).toEqual({
      agentArgs: undefined,
      agentEnv: undefined
    })
  })
})
