import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  queuePendingAgentStartupDelivery,
  resetAgentStartupDelayedDeliveryForTests
} from './agent-startup-delayed-delivery'

const originalState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function seedPendingState(agentLaunchConfigByPaneKey: Record<string, unknown> = {}): void {
  useAppStore.setState({
    tabsByWorktree: {
      'wt-background': [
        {
          id: 'tab-background',
          ptyId: null,
          worktreeId: 'wt-background',
          title: 'Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    pendingStartupByTabId: {
      'tab-background': { launchToken: 'target-launch' }
    },
    agentLaunchConfigByPaneKey,
    ptyIdsByTabId: { 'tab-background': [] },
    terminalLayoutsByTabId: {}
  } as never)
}

function bindPendingPty(): void {
  useAppStore.setState({
    agentLaunchConfigByPaneKey: {
      [`tab-background:${LEAF_ID}`]: {
        identity: {
          tabId: 'tab-background',
          leafId: LEAF_ID,
          launchToken: 'target-launch'
        }
      }
    },
    ptyIdsByTabId: { 'tab-background': ['pty-background'] },
    terminalLayoutsByTabId: {
      'tab-background': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-background' }
      }
    }
  } as never)
}

afterEach(() => {
  resetAgentStartupDelayedDeliveryForTests()
  useAppStore.setState(originalState, true)
})

describe('delayed agent startup subscription', () => {
  it('delivers when launch registration, PTY ownership, and layout binding arrive', () => {
    seedPendingState()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const startup = {} as never
    queuePendingAgentStartupDelivery({
      worktreeId: 'wt-background',
      tabId: 'tab-background',
      launchToken: 'target-launch',
      startup,
      deliver
    })

    bindPendingPty()

    expect(deliver).toHaveBeenCalledWith('tab-background', 'pty-background', startup)
  })

  it('drops a delivery when its tab is removed before PTY binding', () => {
    seedPendingState()
    const deliver = vi.fn().mockResolvedValue(undefined)
    queuePendingAgentStartupDelivery({
      worktreeId: 'wt-background',
      tabId: 'tab-background',
      launchToken: 'target-launch',
      startup: {} as never,
      deliver
    })

    useAppStore.setState({ tabsByWorktree: {} })
    seedPendingState()
    bindPendingPty()

    expect(deliver).not.toHaveBeenCalled()
  })

  it('drops a delivery when a newer pending launch token replaces it', () => {
    seedPendingState()
    const deliver = vi.fn().mockResolvedValue(undefined)
    queuePendingAgentStartupDelivery({
      worktreeId: 'wt-background',
      tabId: 'tab-background',
      launchToken: 'target-launch',
      startup: {} as never,
      deliver
    })

    useAppStore.setState({
      pendingStartupByTabId: {
        'tab-background': { launchToken: 'newer-launch' }
      }
    } as never)
    bindPendingPty()

    expect(deliver).not.toHaveBeenCalled()
  })
})
