import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { makeTab } from '@/store/slices/store-session-test-harness'
import {
  LIVE_LEAF_ID,
  PANE_KEY,
  makeAgentStatus,
  resetNotificationDispatchMockState,
  type NotificationDispatchMockState
} from './notification-dispatch-test-harness'

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

const PARENT_PANE_KEY = `tab-parent:${LIVE_LEAF_ID}`
let state: NotificationDispatchMockState

function dispatchCompletion(): boolean {
  return dispatchTerminalNotification('wt-primary', {
    source: 'agent-task-complete',
    terminalTitle: 'codex',
    paneKey: PANE_KEY
  })
}

describe('child agent notification filtering', () => {
  beforeEach(() => {
    setPresenceGated(false)
    state = resetNotificationDispatchMockState()
    state.tabsByWorktree['wt-secondary'] = [{ id: 'tab-parent', ptyId: 'pty-parent' }]
    state.agentStatusByPaneKey[PARENT_PANE_KEY] = makeAgentStatus(PARENT_PANE_KEY, {
      terminalHandle: 'terminal-parent'
    })
    state.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, {
      orchestration: {
        taskId: 'task-child',
        dispatchId: 'dispatch-child',
        parentPaneKey: PARENT_PANE_KEY
      }
    })
  })

  afterEach(() => {
    setPresenceGated(true)
    vi.unstubAllGlobals()
  })

  it('suppresses hidden child completion delivery and unread attention across workspaces', () => {
    expect(dispatchCompletion()).toBe(false)
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(state.markAgentAttentionUnread).not.toHaveBeenCalled()
  })

  it('delivers completion and unread attention when children are shown', () => {
    state.agentsShowChildAgents = true

    expect(dispatchCompletion()).toBe(true)
    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(state.markAgentAttentionUnread).toHaveBeenCalledTimes(1)
  })

  it.each(['parentTerminalHandle', 'coordinatorHandle'] as const)(
    'resolves %s through a retained parent',
    (parentField) => {
      const parent = state.agentStatusByPaneKey[PARENT_PANE_KEY]
      delete state.agentStatusByPaneKey[PARENT_PANE_KEY]
      state.retainedAgentsByPaneKey[PARENT_PANE_KEY] = {
        entry: parent,
        worktreeId: 'wt-secondary',
        tab: makeTab({
          id: 'tab-parent',
          worktreeId: 'wt-secondary'
        }),
        agentType: 'codex',
        startedAt: parent.stateStartedAt
      }
      state.agentStatusByPaneKey[PANE_KEY].orchestration = {
        taskId: 'task-child',
        dispatchId: 'dispatch-child',
        [parentField]: 'terminal-parent'
      }

      expect(dispatchCompletion()).toBe(false)
      expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    }
  )

  it('uses runtime lineage when the hook row has none', () => {
    state.runtimeAgentOrchestrationByPaneKey[PANE_KEY] = {
      taskId: 'task-child',
      dispatchId: 'dispatch-child',
      parentPaneKey: PARENT_PANE_KEY
    }
    state.agentStatusByPaneKey[PANE_KEY].orchestration = undefined

    expect(dispatchCompletion()).toBe(false)
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  it('keeps a child muted after its hook row is retained on process exit', () => {
    const entry = state.agentStatusByPaneKey[PANE_KEY]
    state.retainedAgentsByPaneKey[PANE_KEY] = {
      entry,
      worktreeId: 'wt-primary',
      tab: makeTab({ id: 'tab-1', worktreeId: 'wt-primary' }),
      agentType: 'codex',
      startedAt: entry.stateStartedAt
    }
    delete state.agentStatusByPaneKey[PANE_KEY]

    expect(
      dispatchTerminalNotification('wt-primary', {
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: PANE_KEY,
        agentCompletionSource: 'process-exit'
      })
    ).toBe(false)
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  it('delivers for orphaned workers promoted to top level', () => {
    delete state.agentStatusByPaneKey[PARENT_PANE_KEY]

    expect(dispatchCompletion()).toBe(true)
    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
  })

  it('delivers for self references and closed parent cycles promoted to top level', () => {
    state.agentStatusByPaneKey[PARENT_PANE_KEY].orchestration = {
      taskId: 'task-parent',
      dispatchId: 'dispatch-parent',
      parentPaneKey: PANE_KEY
    }
    expect(dispatchCompletion()).toBe(true)

    state.agentStatusByPaneKey[PANE_KEY].orchestration = {
      taskId: 'task-child',
      dispatchId: 'dispatch-child',
      parentPaneKey: PANE_KEY
    }
    expect(dispatchCompletion()).toBe(true)
    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(2)
  })

  it.each(['blocked', 'waiting'] as const)('preserves hidden child %s alerts', (agentState) => {
    state.agentStatusByPaneKey[PANE_KEY].state = agentState
    const agentStatusSnapshot = {
      state: agentState,
      agentType: 'codex',
      prompt: 'Approve this action',
      stateStartedAt: state.agentStatusByPaneKey[PANE_KEY].stateStartedAt
    }

    expect(
      dispatchTerminalNotification('wt-primary', {
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: PANE_KEY,
        agentStatusSnapshot
      })
    ).toBe(true)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ agentState })
    )
    expect(state.markAgentAttentionUnread).toHaveBeenCalledTimes(1)
  })

  it('preserves explicit terminal bells from hidden children', () => {
    expect(
      dispatchTerminalNotification('wt-primary', {
        source: 'terminal-bell',
        paneKey: PANE_KEY
      })
    ).toBe(true)
    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
  })
})
