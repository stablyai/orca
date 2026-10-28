import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TuiAgent } from '../../../shared/tui-agent'
import { launchFloatingWorkspaceAgentShortcut } from './agent-tab-shortcut-launch'

const mocks = vi.hoisted(() => {
  const activeGroupIdByWorktree: Record<string, string> = {}
  return {
    state: {
      activeGroupIdByWorktree,
      groupsByWorktree: {},
      settings: { floatingTerminalEnabled: true },
      floatingWorkspacePanelOpen: true
    },
    launchAgentInNewTab: vi.fn(),
    cancelFocusIntent: vi.fn()
  }
})

vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  captureNativeChatComposerFocusIntent: () => ({
    request: vi.fn(),
    cancel: mocks.cancelFocusIntent
  })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

function pendingDetection(): {
  pendingAgent: Promise<TuiAgent | null>
  settle: (agent: TuiAgent | null) => Promise<void>
} {
  let resolve: (agent: TuiAgent | null) => void = () => undefined
  const pendingAgent = new Promise<TuiAgent | null>((settle) => {
    resolve = settle
  })
  return {
    pendingAgent,
    settle: async (agent) => {
      resolve(agent)
      await pendingAgent
    }
  }
}

describe('launchFloatingWorkspaceAgentShortcut while detection is pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 't' } })
    mocks.state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: 'group-a' }
    mocks.state.floatingWorkspacePanelOpen = true
  })

  it('opens the agent in the floating group the shortcut was pressed in', async () => {
    const detection = pendingDetection()
    launchFloatingWorkspaceAgentShortcut({ agent: null, pendingAgent: detection.pendingAgent })
    mocks.state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: 'group-b' }

    await detection.settle('claude')

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        groupId: 'group-a'
      })
    )
  })

  it('drops the launch when the panel closed before detection settled', async () => {
    const detection = pendingDetection()
    launchFloatingWorkspaceAgentShortcut({ agent: null, pendingAgent: detection.pendingAgent })
    mocks.state.floatingWorkspacePanelOpen = false

    await detection.settle('claude')

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.cancelFocusIntent).toHaveBeenCalledTimes(1)
  })
})
