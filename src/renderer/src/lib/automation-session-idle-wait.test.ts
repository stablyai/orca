import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { waitForIdleAutomationSession } from './automation-session-reuse'

const LEAF_ID = '7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'
const WAIT_TIMEOUT_MS = 60 * 60 * 1000
const SESSION = { tabId: 'tab-1', ptyId: 'pty-1', paneKey: `tab-1:${LEAF_ID}` }

type PaneState = {
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
}

let state: PaneState
const listeners = new Set<() => void>()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))

function paneStatus(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'turn',
    updatedAt: 2,
    stateStartedAt: 1,
    paneKey: SESSION.paneKey,
    stateHistory: [],
    ...overrides
  }
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

describe('waitForIdleAutomationSession', () => {
  beforeEach(() => {
    listeners.clear()
    state = {
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' } } },
      agentStatusByPaneKey: {
        [SESSION.paneKey]: paneStatus({ state: 'working', agentType: 'claude' })
      }
    }
  })

  it('resolves the session once the busy agent finishes its turn', async () => {
    const waiting = waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    state.agentStatusByPaneKey = {
      [SESSION.paneKey]: paneStatus({ state: 'done', agentType: 'claude' })
    }
    notify()

    await expect(waiting).resolves.toEqual(SESSION)
    expect(listeners.size).toBe(0)
  })

  it('resolves immediately for a session that is already idle', async () => {
    state.agentStatusByPaneKey = {
      [SESSION.paneKey]: paneStatus({ state: 'done', agentType: 'claude' })
    }

    await expect(
      waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
    ).resolves.toEqual(SESSION)
    expect(listeners.size).toBe(0)
  })

  it('gives up when the pane no longer holds the run PTY', async () => {
    const waiting = waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
    state.ptyIdsByTabId = { 'tab-1': ['pty-2'] }
    notify()

    await expect(waiting).resolves.toBeNull()
  })

  it('gives up when the pane stops reporting agent status', async () => {
    const waiting = waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
    state.agentStatusByPaneKey = {}
    notify()

    await expect(waiting).resolves.toBeNull()
  })

  it('gives up when another agent type holds the pane', async () => {
    state.agentStatusByPaneKey = {
      [SESSION.paneKey]: paneStatus({ state: 'working', agentType: 'codex' })
    }

    await expect(
      waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
    ).resolves.toBeNull()
    expect(listeners.size).toBe(0)
  })

  it('gives up when the pane only reports a session boundary', async () => {
    state.agentStatusByPaneKey = {
      [SESSION.paneKey]: paneStatus({ state: 'done', agentType: 'claude', sessionBoundary: true })
    }

    await expect(
      waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
    ).resolves.toBeNull()
    expect(listeners.size).toBe(0)
  })

  it('stops waiting when the busy turn outlasts the wait timeout', async () => {
    vi.useFakeTimers()
    try {
      const waiting = waitForIdleAutomationSession({ session: SESSION, agentId: 'claude' })
      expect(listeners.size).toBe(1)

      await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS)

      await expect(waiting).resolves.toBeNull()
      expect(listeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
