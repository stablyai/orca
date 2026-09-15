import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import {
  LIVE_LEAF_ID,
  PANE_KEY,
  STALE_LEAF_ID,
  STALE_PANE_KEY,
  getLastNotificationDispatchArg,
  makeAgentStatus,
  resetNotificationDispatchMockState,
  stubDocumentFocus,
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

let mockState: NotificationDispatchMockState

describe('dispatchTerminalNotification', () => {
  const liveLeafId = LIVE_LEAF_ID
  const staleLeafId = STALE_LEAF_ID
  const paneKey = PANE_KEY
  const stalePaneKey = STALE_PANE_KEY

  beforeEach(() => {
    mockState = resetNotificationDispatchMockState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses a live pane key when marking inactive worktree attention', () => {
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        notificationId: buildAgentNotificationId({
          worktreeId: 'wt-primary',
          paneKey,
          stateStartedAt: mockState.agentStatusByPaneKey[paneKey].stateStartedAt
        }),
        worktreeId: 'wt-primary',
        paneKey,
        repoLabel: 'orca',
        worktreeLabel: 'master',
        terminalTitle: 'codex',
        isActiveWorktree: false,
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'codex-hook-notify',
        agentLastAssistantMessage: 'Done.'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
  })

  it('builds the notification id from a completion snapshot, not the pinned working row', () => {
    const pinnedWorkingStartedAt = Date.now() - 60_000
    // Why: the stored row must name the event's agent, or it is dropped for identity mismatch
    // and the assertion would hold whichever side of the `??` wins.
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      stateStartedAt: pinnedWorkingStartedAt,
      agentType: 'claude',
      terminalTitle: 'claude'
    })
    const turnCompletedAt = Date.now()

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'review the PR',
        agentType: 'claude',
        stateStartedAt: turnCompletedAt
      }
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: buildAgentNotificationId({
          worktreeId: 'wt-primary',
          paneKey,
          stateStartedAt: turnCompletedAt
        })
      })
    )
  })

  it.each([
    { clientStateStartedAt: 5_000, hostTurnCompletedAt: 2_000 },
    { clientStateStartedAt: 2_000, hostTurnCompletedAt: 5_000 }
  ])(
    'accepts a host-stamped completion across client/host clock skew %#',
    ({ clientStateStartedAt, hostTurnCompletedAt }) => {
      mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
        state: 'working',
        stateStartedAt: clientStateStartedAt,
        agentType: 'claude',
        terminalTitle: 'claude'
      })

      dispatchTerminalNotification('wt-primary', {
        source: 'agent-task-complete',
        terminalTitle: 'claude',
        paneKey,
        agentStatusSnapshot: {
          state: 'done',
          prompt: 'review the PR',
          agentType: 'claude',
          stateStartedAt: hostTurnCompletedAt,
          localStateStartedAt: clientStateStartedAt,
          turnCompletedAt: hostTurnCompletedAt
        }
      })

      expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
    }
  )

  it('drops a host-stamped completion after a newer client turn starts', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      stateStartedAt: 6_000,
      agentType: 'claude',
      terminalTitle: 'claude'
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'previous turn',
        agentType: 'claude',
        stateStartedAt: 2_000,
        localStateStartedAt: 5_000,
        turnCompletedAt: 2_000
      }
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  it('uses a live pane key when inactive worktree tab membership is not hydrated', () => {
    mockState.tabsByWorktree = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
  })

  it('uses tab liveness when the layout has the leaf but no leaf pty binding yet', () => {
    mockState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
  })

  it('falls back to background-worktree unread when terminal attention is disabled', () => {
    mockState.settings.experimentalTerminalAttention = false

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(
      paneKey,
      'agent-completion'
    )
  })

  it('offers attention-only completion to main for independent mobile delivery', () => {
    mockState.settings.notifications = { ...mockState.settings.notifications, enabled: false }
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
    expect(window.api.notifications.dispatch).toHaveBeenCalled()
  })

  it('writes unread with the completion reason while the agent-complete banner toggle is off', () => {
    // Why: the renderer never reads the desktop banner gate — main applies it after unread
    // and mobile delivery, so a disabled banner must still leave unread + tray attention.
    mockState.settings.notifications = {
      ...mockState.settings.notifications,
      enabled: true,
      agentTaskComplete: false
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(
      paneKey,
      'agent-completion'
    )
    expect(window.api.notifications.dispatch).toHaveBeenCalled()
  })

  it('records a bell as a distinct reason and never as an agent completion', () => {
    dispatchTerminalNotification('wt-primary', { source: 'terminal-bell', paneKey })

    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell', paneKey })
    )
  })

  it('does not mark the visible focused pane unread', () => {
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
  })

  it('marks a hidden tab in the focused worktree unread', () => {
    const hiddenLeafId = '33333333-3333-4333-8333-333333333333'
    const hiddenPaneKey = `tab-2:${hiddenLeafId}`
    mockState.activeWorktreeId = 'wt-primary'
    mockState.activeTabId = 'tab-1'
    mockState.tabsByWorktree['wt-primary'].push({ id: 'tab-2', ptyId: 'pty-2' })
    mockState.ptyIdsByTabId['tab-2'] = ['pty-2']
    mockState.terminalLayoutsByTabId['tab-2'] = {
      root: { type: 'leaf', leafId: hiddenLeafId },
      activeLeafId: hiddenLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [hiddenLeafId]: 'pty-2' }
    }
    mockState.agentStatusByPaneKey[hiddenPaneKey] = makeAgentStatus(hiddenPaneKey)
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: hiddenPaneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-2', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(hiddenPaneKey, 'agent-completion')
  })

  it('marks a hidden split pane in the focused tab unread', () => {
    const siblingPaneKey = stalePaneKey
    mockState.activeWorktreeId = 'wt-primary'
    mockState.activeTabId = 'tab-1'
    mockState.ptyIdsByTabId['tab-1'] = ['pty-1', 'pty-2']
    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: liveLeafId },
        second: { type: 'leaf', leafId: staleLeafId }
      },
      activeLeafId: liveLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [liveLeafId]: 'pty-1', [staleLeafId]: 'pty-2' }
    }
    mockState.agentStatusByPaneKey[siblingPaneKey] = makeAgentStatus(siblingPaneKey)
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: siblingPaneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(
      siblingPaneKey,
      'agent-completion'
    )
  })

  it('marks the selected worktree unread when Orca is backgrounded', () => {
    mockState.settings.experimentalTerminalAttention = false
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'hidden', focused: false })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(
      paneKey,
      'agent-completion'
    )
  })

  it('drops a pane key when its tab is hydrated under another worktree', () => {
    mockState.tabsByWorktree = {
      'wt-secondary': [{ id: 'tab-1' }]
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('does not mark unread for a stale closed pane key when another pty in the tab is live', () => {
    mockState.agentStatusByPaneKey[stalePaneKey] = makeAgentStatus(stalePaneKey)

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: stalePaneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('uses a fresh hook snapshot when inactive PTY liveness has not caught up', () => {
    mockState.ptyIdsByTabId = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'codex-hook-notify',
        agentLastAssistantMessage: 'Done.'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
  })

  it('uses accepted hook snapshot timing for the notification id when the live store row is gone before dispatch', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}
    const stateStartedAt = Date.now() - 1_000

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'codex-hook-notify',
        agentType: 'codex',
        lastAssistantMessage: 'Done.',
        stateStartedAt
      }
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        notificationId: buildAgentNotificationId({
          worktreeId: 'wt-primary',
          paneKey,
          stateStartedAt
        }),
        worktreeId: 'wt-primary',
        paneKey,
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'codex-hook-notify',
        agentLastAssistantMessage: 'Done.'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
  })

  it('does not let fresh active status suppress a completion from another named agent', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      agentType: 'codex',
      terminalTitle: 'Codex',
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: '✳ Claude Code',
      paneKey
    })

    const dispatchArgs = getLastNotificationDispatchArg()
    expect(dispatchArgs).toEqual(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        terminalTitle: '✳ Claude Code'
      })
    )
    expect(dispatchArgs?.agentType).toBeUndefined()
    expect(dispatchArgs?.agentLastAssistantMessage).toBeUndefined()
  })

  it('does not reuse an event snapshot when the terminal title names another agent', () => {
    mockState.agentStatusByPaneKey = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: '✳ Claude Code',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'codex prompt',
        agentType: 'codex',
        lastAssistantMessage: 'Codex done.',
        stateStartedAt: Date.now()
      }
    })

    const dispatchArgs = getLastNotificationDispatchArg()
    expect(dispatchArgs).toEqual(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        terminalTitle: '✳ Claude Code'
      })
    )
    expect(dispatchArgs?.notificationId).toBeUndefined()
    expect(dispatchArgs?.agentType).toBeUndefined()
    expect(dispatchArgs?.agentPrompt).toBeUndefined()
    expect(dispatchArgs?.agentLastAssistantMessage).toBeUndefined()
  })

  it('does not reuse an untyped fresh agent snapshot when the terminal title names an agent', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      agentType: undefined,
      terminalTitle: 'unknown',
      lastAssistantMessage: 'Previous agent done.'
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'Claude Code',
      paneKey
    })

    const dispatchArgs = getLastNotificationDispatchArg()
    expect(dispatchArgs).toEqual(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        terminalTitle: 'Claude Code'
      })
    )
    expect(dispatchArgs?.agentType).toBeUndefined()
    expect(dispatchArgs?.agentLastAssistantMessage).toBeUndefined()
  })

  it('keeps a fresh agent snapshot when the terminal title matches the stored agent', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      agentType: 'codex',
      terminalTitle: 'Codex',
      lastAssistantMessage: 'Codex done.'
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: '⠋ Codex',
      paneKey
    })

    const dispatchArgs = getLastNotificationDispatchArg()
    expect(dispatchArgs).toEqual(
      expect.objectContaining({
        agentType: 'codex',
        agentLastAssistantMessage: 'Codex done.'
      })
    )
  })

  it('drops a title-only completion when fresh hook state is still active', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'still running',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: '✳ Launch UI and thumbnail generator',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('allows confirmed process-exit completion while fresh hook state is still active', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'agent crashed before its done hook',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentCompletionSource: 'process-exit'
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        terminalTitle: 'codex'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
    const dispatchArgs = getLastNotificationDispatchArg()
    expect(dispatchArgs?.agentState).toBeUndefined()
    expect(dispatchArgs?.agentPrompt).toBeUndefined()
  })

  it.each([undefined, 'unknown'] as const)(
    'drops an explicitly named title completion when fresh hook identity is %s',
    (agentType) => {
      mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
        state: 'working',
        agentType,
        updatedAt: Date.now() - 60_000,
        stateStartedAt: Date.now() - 60_000,
        lastAssistantMessage: undefined
      })

      dispatchTerminalNotification('wt-primary', {
        source: 'agent-task-complete',
        terminalTitle: 'Claude Code done',
        paneKey
      })

      expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
      expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
      expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
      expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    }
  )

  it('drops a Pi title completion while compatible OMP hook status is active', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      agentType: 'omp',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'Pi ready',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('allows title-only completion after active hook status becomes stale', () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
      stateStartedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: '/workspace/orca',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
  })

  it('drops a delayed completion snapshot when the pane has already started a newer turn', () => {
    const previousDoneStartedAt = Date.now() - 10_000
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'new prompt already running',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'previous prompt',
        agentType: 'codex',
        lastAssistantMessage: 'Done.',
        stateStartedAt: previousDoneStartedAt
      }
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('drops accepted hook snapshots for an intentionally suppressed pty', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}
    mockState.suppressedPtyExitIds = { 'pty-1': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'codex-hook-notify',
        agentType: 'codex',
        lastAssistantMessage: 'Done.'
      }
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('drops final-flush notifications for suppressed live ptys', () => {
    mockState.suppressedPtyExitIds = { 'pty-1': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('drops layout-fallback notifications when all tab PTYs are suppressed', () => {
    mockState.suppressedPtyExitIds = { 'pty-1': true }
    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('still drops stale notifications when neither pty liveness nor fresh hook status exists', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey[paneKey] = {
      ...makeAgentStatus(paneKey),
      updatedAt: Date.now() - 11_000
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })
})
