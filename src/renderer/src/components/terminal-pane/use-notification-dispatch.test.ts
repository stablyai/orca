import { makeAgentStatus, type MockState } from './notification-dispatch-test-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'

const playDesktopNotificationSound = vi.hoisted(() => vi.fn())
let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound
}))

function stubDocumentFocus({
  visibilityState,
  focused
}: {
  visibilityState: DocumentVisibilityState
  focused: boolean
}): void {
  vi.stubGlobal('document', {
    visibilityState,
    hasFocus: vi.fn(() => focused)
  })
}

function getLastNotificationDispatchArg(): Record<string, unknown> | undefined {
  const dispatch = window.api.notifications.dispatch as unknown as ReturnType<typeof vi.fn>
  return dispatch.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
}

describe('dispatchTerminalNotification', () => {
  const liveLeafId = '11111111-1111-4111-8111-111111111111'
  const staleLeafId = '22222222-2222-4222-8222-222222222222'
  const paneKey = `tab-1:${liveLeafId}`
  const stalePaneKey = `tab-1:${staleLeafId}`

  beforeEach(() => {
    vi.clearAllMocks()
    mockState = {
      runtimeEnvironments: [],
      activeWorktreeId: 'wt-secondary',
      activeTabId: 'tab-1',
      tabsByWorktree: {
        'wt-primary': [{ id: 'tab-1', ptyId: 'pty-1' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      suppressedPtyExitIds: {},
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: liveLeafId },
          activeLeafId: liveLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [liveLeafId]: 'pty-1' }
        }
      },
      browserTabsByWorktree: {},
      retainedAgentsByPaneKey: {},
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatus(paneKey)
      },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-primary',
            repoId: 'repo1',
            displayName: 'master',
            branch: 'master'
          },
          {
            id: 'wt-secondary',
            repoId: 'repo1',
            displayName: 'e2e-secondary',
            branch: 'e2e-secondary'
          }
        ]
      },
      repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
      settings: { experimentalTerminalAttention: true, notifications: { customSoundPath: null } },
      markWorktreeUnread: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn()
    }
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['read', 'closed'])(
    'does not add unread when the pane was %s while IPC was pending',
    async (action) => {
      let finish!: (result: { delivered: boolean }) => void
      vi.mocked(window.api.notifications.dispatch).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const pending = dispatchTerminalNotification('wt-primary', {
        source: 'agent-task-complete',
        paneKey
      })
      if (action === 'closed') {
        mockState.tabsByWorktree['wt-primary'] = []
        mockState.terminalLayoutsByTabId = {}
        mockState.ptyIdsByTabId = {}
      } else {
        mockState.activeWorktreeId = 'wt-primary'
        stubDocumentFocus({ visibilityState: 'visible', focused: true })
      }
      finish({ delivered: false })
      await pending
      expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    }
  )

  it('waits for the host recipient decision before marking unread', async () => {
    vi.mocked(window.api.notifications.dispatch).mockResolvedValue({
      delivered: false,
      reason: 'not-recipient'
    })
    await dispatchTerminalNotification('wt-primary', { source: 'agent-task-complete', paneKey })
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(playDesktopNotificationSound).not.toHaveBeenCalled()
  })

  it.each(['a', 'b', null])(
    'isolates remote run origin %s before local phone forwarding',
    async (deviceId) => {
      mockState.runtimeEnvironments = [{ id: 'remote-host', pairedDeviceId: 'a' }]
      mockState.ptyIdsByTabId['tab-1'] = ['remote:remote-host@@term_1']
      mockState.terminalLayoutsByTabId['tab-1']!.ptyIdsByLeafId = {
        [liveLeafId]: 'remote:remote-host@@term_1'
      }
      mockState.tabsByWorktree['wt-primary']![0]!.workOriginsByLeafId = {
        [liveLeafId]: deviceId ? { kind: 'paired-device', deviceId } : null
      }
      await dispatchTerminalNotification('wt-primary', { source: 'agent-task-complete', paneKey })
      expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(deviceId === 'a' ? 1 : 0)
      expect(mockState.markWorktreeUnread).toHaveBeenCalledTimes(deviceId === 'a' ? 1 : 0)
      if (deviceId === 'a') {
        expect(getLastNotificationDispatchArg()?.workOrigin).toEqual({ kind: 'host' })
      }
    }
  )

  it('uses a live pane key when marking inactive worktree attention', async () => {
    await dispatchTerminalNotification('wt-primary', {
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
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('builds the notification id from a completion snapshot, not the pinned working row', async () => {
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

    await dispatchTerminalNotification('wt-primary', {
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
    async ({ clientStateStartedAt, hostTurnCompletedAt }) => {
      mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
        state: 'working',
        stateStartedAt: clientStateStartedAt,
        agentType: 'claude',
        terminalTitle: 'claude'
      })

      await dispatchTerminalNotification('wt-primary', {
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

  it('drops a host-stamped completion after a newer client turn starts', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      stateStartedAt: 6_000,
      agentType: 'claude',
      terminalTitle: 'claude'
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('uses a live pane key when inactive worktree tab membership is not hydrated', async () => {
    mockState.tabsByWorktree = {}

    await dispatchTerminalNotification('wt-primary', {
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
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('uses tab liveness when the layout has the leaf but no leaf pty binding yet', async () => {
    mockState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}

    await dispatchTerminalNotification('wt-primary', {
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
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('falls back to background-worktree unread when terminal attention is disabled', async () => {
    mockState.settings.experimentalTerminalAttention = false

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('offers attention-only completion to main for independent mobile delivery', async () => {
    mockState.settings.notifications = { ...mockState.settings.notifications, enabled: false }
    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
    expect(window.api.notifications.dispatch).toHaveBeenCalled()
  })

  it('does not mark the visible focused pane unread', async () => {
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    await dispatchTerminalNotification('wt-primary', {
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

  it('marks a hidden tab in the focused worktree unread', async () => {
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

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: hiddenPaneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-2')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(hiddenPaneKey)
  })

  it('marks a hidden split pane in the focused tab unread', async () => {
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

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: siblingPaneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(siblingPaneKey)
  })

  it('marks the selected worktree unread when Orca is backgrounded', async () => {
    mockState.settings.experimentalTerminalAttention = false
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'hidden', focused: false })

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('drops a pane key when its tab is hydrated under another worktree', async () => {
    mockState.tabsByWorktree = {
      'wt-secondary': [{ id: 'tab-1' }]
    }

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('does not mark unread for a stale closed pane key when another pty in the tab is live', async () => {
    mockState.agentStatusByPaneKey[stalePaneKey] = makeAgentStatus(stalePaneKey)

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: stalePaneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('uses a fresh hook snapshot when inactive PTY liveness has not caught up', async () => {
    mockState.ptyIdsByTabId = {}

    await dispatchTerminalNotification('wt-primary', {
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
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('uses accepted hook snapshot timing for the notification id when the live store row is gone before dispatch', async () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}
    const stateStartedAt = Date.now() - 1_000

    await dispatchTerminalNotification('wt-primary', {
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
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('does not let fresh active status suppress a completion from another named agent', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      agentType: 'codex',
      terminalTitle: 'Codex',
      lastAssistantMessage: undefined
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('does not reuse an event snapshot when the terminal title names another agent', async () => {
    mockState.agentStatusByPaneKey = {}

    await dispatchTerminalNotification('wt-primary', {
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

  it('does not reuse an untyped fresh agent snapshot when the terminal title names an agent', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      agentType: undefined,
      terminalTitle: 'unknown',
      lastAssistantMessage: 'Previous agent done.'
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('keeps a fresh agent snapshot when the terminal title matches the stored agent', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      agentType: 'codex',
      terminalTitle: 'Codex',
      lastAssistantMessage: 'Codex done.'
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('drops a title-only completion when fresh hook state is still active', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'still running',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      lastAssistantMessage: undefined
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('allows confirmed process-exit completion while fresh hook state is still active', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'agent crashed before its done hook',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      lastAssistantMessage: undefined
    })

    await dispatchTerminalNotification('wt-primary', {
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
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
    const dispatchArgs = getLastNotificationDispatchArg()
    expect(dispatchArgs?.agentState).toBeUndefined()
    expect(dispatchArgs?.agentPrompt).toBeUndefined()
  })

  it.each([undefined, 'unknown'] as const)(
    'drops an explicitly named title completion when fresh hook identity is %s',
    async (agentType) => {
      mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
        state: 'working',
        agentType,
        updatedAt: Date.now() - 60_000,
        stateStartedAt: Date.now() - 60_000,
        lastAssistantMessage: undefined
      })

      await dispatchTerminalNotification('wt-primary', {
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

  it('drops a Pi title completion while compatible OMP hook status is active', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      agentType: 'omp',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      lastAssistantMessage: undefined
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('allows title-only completion after active hook status becomes stale', async () => {
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
      stateStartedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
      lastAssistantMessage: undefined
    })

    await dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: '/workspace/orca',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
  })

  it('drops a delayed completion snapshot when the pane has already started a newer turn', async () => {
    const previousDoneStartedAt = Date.now() - 10_000
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'new prompt already running',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      lastAssistantMessage: undefined
    })

    await dispatchTerminalNotification('wt-primary', {
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

  it('drops accepted hook snapshots for an intentionally suppressed pty', async () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}
    mockState.suppressedPtyExitIds = { 'pty-1': true }

    await dispatchTerminalNotification('wt-primary', {
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

  it('drops final-flush notifications for suppressed live ptys', async () => {
    mockState.suppressedPtyExitIds = { 'pty-1': true }

    await dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('drops layout-fallback notifications when all tab PTYs are suppressed', async () => {
    mockState.suppressedPtyExitIds = { 'pty-1': true }
    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }

    await dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('still drops stale notifications when neither pty liveness nor fresh hook status exists', async () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey[paneKey] = {
      ...makeAgentStatus(paneKey),
      updatedAt: Date.now() - 11_000
    }

    await dispatchTerminalNotification('wt-primary', {
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
