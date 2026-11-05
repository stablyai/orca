import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
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

function countedLaunchConfigs(count: number): {
  reads: { value: number }
  record: Record<string, unknown>
} {
  const reads = { value: 0 }
  const record: Record<string, unknown> = {}
  for (let index = 0; index < count; index += 1) {
    Object.defineProperty(record, `other-pane-${index}`, {
      enumerable: true,
      get: () => {
        reads.value += 1
        return {
          identity: {
            tabId: `other-tab-${index}`,
            launchToken: `other-launch-${index}`
          }
        }
      }
    })
  }
  return { reads, record }
}

afterEach(() => {
  resetAgentStartupDelayedDeliveryForTests()
  useAppStore.setState(originalState, true)
})

describe('delayed agent startup subscription', () => {
  it('does not rescan launch metadata for unrelated store updates', () => {
    const launchConfigs = countedLaunchConfigs(500)
    seedPendingState(launchConfigs.record)

    queuePendingAgentStartupDelivery({
      worktreeId: 'wt-background',
      tabId: 'tab-background',
      launchToken: 'target-launch',
      startup: {} as never,
      deliver: vi.fn()
    })
    expect(launchConfigs.reads.value).toBe(500)

    launchConfigs.reads.value = 0
    for (let update = 0; update < 100; update += 1) {
      useAppStore.setState({ activeView: update % 2 === 0 ? 'terminal' : 'settings' } as never)
    }

    expect(launchConfigs.reads.value).toBe(0)
  })

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
