import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type RimStoreState = {
  agentStatusByPaneKey: Record<string, { state: AgentStatusState; interrupted?: boolean }>
  unreadAgentCompletionPanes: Record<string, true>
}

const storeMock = vi.hoisted(() => ({
  state: {
    agentStatusByPaneKey: {},
    unreadAgentCompletionPanes: {}
  } as {
    agentStatusByPaneKey: Record<string, { state: AgentStatusState; interrupted?: boolean }>
    unreadAgentCompletionPanes: Record<string, true>
  },
  subscribers: [] as ((state: RimStoreState) => void)[]
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeMock.state,
    subscribe: (listener: (state: RimStoreState) => void) => {
      storeMock.subscribers.push(listener)
      return () => {
        storeMock.subscribers = storeMock.subscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

import {
  applyAgentPaneRimToManager,
  resetAgentPaneRimSubscriptionsForTests,
  subscribeAgentPaneRim
} from './agent-pane-rim-subscriptions'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

function emitStoreChange(): void {
  for (const subscriber of storeMock.subscribers.slice()) {
    subscriber(storeMock.state)
  }
}

function createPane(leafId: string) {
  const attributes = new Map<string, string>()
  return {
    leafId,
    container: {
      setAttribute: vi.fn((name: string, value: string) => {
        attributes.set(name, value)
      }),
      removeAttribute: vi.fn((name: string) => {
        attributes.delete(name)
      }),
      hasAttribute: (name: string) => attributes.has(name),
      getAttribute: (name: string) => attributes.get(name) ?? null
    }
  }
}

function createManager(panes: ReturnType<typeof createPane>[]) {
  return {
    getPanes: () => panes
  }
}

describe('agent pane rim subscriptions', () => {
  beforeEach(() => {
    storeMock.state = {
      agentStatusByPaneKey: {},
      unreadAgentCompletionPanes: {}
    }
    storeMock.subscribers = []
  })

  afterEach(() => {
    resetAgentPaneRimSubscriptionsForTests()
    storeMock.subscribers = []
  })

  it('shares one store subscriber and notifies only tabs whose rim result changed', () => {
    const tab1Listener = vi.fn()
    const tab2Listener = vi.fn()
    const unsubscribeTab1 = subscribeAgentPaneRim('tab-1', tab1Listener)
    const unsubscribeTab2 = subscribeAgentPaneRim('tab-2', tab2Listener)

    expect(storeMock.subscribers).toHaveLength(1)

    storeMock.state = {
      ...storeMock.state,
      agentStatusByPaneKey: { [makePaneKey('tab-1', LEAF_1)]: { state: 'waiting' } }
    }
    emitStoreChange()

    expect(tab1Listener).toHaveBeenCalledTimes(1)
    expect(tab2Listener).not.toHaveBeenCalled()

    storeMock.state = {
      ...storeMock.state,
      unreadAgentCompletionPanes: { [makePaneKey('tab-2', LEAF_2)]: true }
    }
    emitStoreChange()

    expect(tab1Listener).toHaveBeenCalledTimes(1)
    expect(tab2Listener).toHaveBeenCalledTimes(1)

    unsubscribeTab1()
    expect(storeMock.subscribers).toHaveLength(1)
    unsubscribeTab2()
    expect(storeMock.subscribers).toHaveLength(0)
  })

  it('does not notify when a state change does not alter the rim result', () => {
    const tab1Listener = vi.fn()
    subscribeAgentPaneRim('tab-1', tab1Listener)

    // working -> idle: neither yields a rim, so no notification.
    storeMock.state = {
      ...storeMock.state,
      agentStatusByPaneKey: { [makePaneKey('tab-1', LEAF_1)]: { state: 'working' } }
    }
    emitStoreChange()
    expect(tab1Listener).not.toHaveBeenCalled()
  })

  it('marks waiting and blocked panes as the waiting rim', () => {
    storeMock.state = {
      ...storeMock.state,
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF_1)]: { state: 'waiting' },
        [makePaneKey('tab-1', LEAF_2)]: { state: 'blocked' },
        [makePaneKey('tab-1', LEAF_3)]: { state: 'working' }
      }
    }
    const paneWaiting = createPane(LEAF_1)
    const paneBlocked = createPane(LEAF_2)
    const paneWorking = createPane(LEAF_3)

    applyAgentPaneRimToManager(
      createManager([paneWaiting, paneBlocked, paneWorking]) as never,
      'tab-1'
    )

    expect(paneWaiting.container.getAttribute('data-agent-rim')).toBe('waiting')
    expect(paneBlocked.container.getAttribute('data-agent-rim')).toBe('waiting')
    expect(paneWorking.container.hasAttribute('data-agent-rim')).toBe(false)
  })

  it('does not mark an interrupted waiting pane as the waiting rim', () => {
    storeMock.state = {
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF_1)]: { state: 'waiting', interrupted: true }
      },
      unreadAgentCompletionPanes: {}
    }
    const pane = createPane(LEAF_1)

    applyAgentPaneRimToManager(createManager([pane]) as never, 'tab-1')

    expect(pane.container.hasAttribute('data-agent-rim')).toBe(false)
  })

  it('falls back to the done rim for an interrupted pane with an unviewed completion', () => {
    const paneKey = makePaneKey('tab-1', LEAF_1)
    storeMock.state = {
      agentStatusByPaneKey: { [paneKey]: { state: 'waiting', interrupted: true } },
      unreadAgentCompletionPanes: { [paneKey]: true }
    }
    const pane = createPane(LEAF_1)

    applyAgentPaneRimToManager(createManager([pane]) as never, 'tab-1')

    expect(pane.container.getAttribute('data-agent-rim')).toBe('done')
  })

  it('does not paint a working pane green from a not-yet-cleared completion marker', () => {
    const paneKey = makePaneKey('tab-1', LEAF_1)
    storeMock.state = {
      agentStatusByPaneKey: { [paneKey]: { state: 'working' } },
      unreadAgentCompletionPanes: { [paneKey]: true }
    }
    const pane = createPane(LEAF_1)

    applyAgentPaneRimToManager(createManager([pane]) as never, 'tab-1')

    expect(pane.container.hasAttribute('data-agent-rim')).toBe(false)
  })

  it('marks an unviewed-completion pane as the done rim', () => {
    storeMock.state = {
      ...storeMock.state,
      unreadAgentCompletionPanes: { [makePaneKey('tab-1', LEAF_1)]: true }
    }
    const pane = createPane(LEAF_1)

    applyAgentPaneRimToManager(createManager([pane]) as never, 'tab-1')

    expect(pane.container.getAttribute('data-agent-rim')).toBe('done')
  })

  it('prefers the waiting rim over a completion marker on the same pane', () => {
    const paneKey = makePaneKey('tab-1', LEAF_1)
    storeMock.state = {
      agentStatusByPaneKey: { [paneKey]: { state: 'waiting' } },
      unreadAgentCompletionPanes: { [paneKey]: true }
    }
    const pane = createPane(LEAF_1)

    applyAgentPaneRimToManager(createManager([pane]) as never, 'tab-1')

    expect(pane.container.getAttribute('data-agent-rim')).toBe('waiting')
  })

  it('removes the rim attribute from panes with no active rim', () => {
    const pane = createPane(LEAF_1)
    applyAgentPaneRimToManager(createManager([pane]) as never, 'tab-1')
    expect(pane.container.hasAttribute('data-agent-rim')).toBe(false)
    expect(pane.container.removeAttribute).toHaveBeenCalledWith('data-agent-rim')
  })
})
