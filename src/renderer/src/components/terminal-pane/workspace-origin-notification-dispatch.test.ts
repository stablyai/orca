import { afterEach, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  PANE_KEY,
  makeAgentStatus,
  resetNotificationDispatchMockState
} from './notification-dispatch-test-harness'

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

afterEach(() => vi.unstubAllGlobals())

it.each([
  [false, false],
  [false, true],
  [true, false]
] as const)(
  'delivers an unhydrated folder completion with CLI: %s, automation: %s',
  (cliWorktreeTaskComplete, automationWorktreeTaskComplete) => {
    const state = resetNotificationDispatchMockState()
    const workspaceId = 'folder:unhydrated'
    state.settings.notifications = { cliWorktreeTaskComplete, automationWorktreeTaskComplete }
    state.tabsByWorktree = { [workspaceId]: state.tabsByWorktree['wt-primary'] }
    dispatchTerminalNotification(workspaceId, {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceOrigin: 'other', worktreeId: workspaceId })
    )
    expect(state.markWorktreeUnread).toHaveBeenCalledWith(workspaceId)
    expect(state.markAgentCompletionPaneUnread).toHaveBeenCalledWith(PANE_KEY, 'agent-completion')
  }
)

it.each(['cli', 'automation'] as const)(
  'preserves every unread marker and sends %s provenance to the main delivery gate',
  (workspaceOrigin) => {
    const state = resetNotificationDispatchMockState()
    if (workspaceOrigin === 'cli') {
      state.worktreesByRepo.repo1[0].cliProvenance = { kind: 'created-by-cli', createdAt: 1 }
    } else {
      state.worktreesByRepo.repo1[0].automationProvenance = {
        kind: 'created-by-automation',
        automationId: 'automation',
        automationNameSnapshot: 'Daily',
        automationRunId: 'run',
        automationRunTitleSnapshot: 'Daily run',
        createdAt: 1,
        executionTargetType: 'local',
        executionTargetId: 'repo',
        projectId: 'project'
      }
    }
    state.settings.notifications = {
      enabled: true,
      agentTaskComplete: true,
      cliWorktreeTaskComplete: false,
      automationWorktreeTaskComplete: false
    }
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceOrigin })
    )
    expect(state.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(state.markAgentCompletionPaneUnread).toHaveBeenCalledWith(PANE_KEY, 'agent-completion')
    expect(state.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(state.markTerminalPaneUnread).toHaveBeenCalledWith(PANE_KEY, 'agent-completion')
  }
)

it.each([
  ['missing', false, false],
  ['missing', false, true],
  ['missing', true, false],
  ['ambiguous', false, false],
  ['ambiguous', false, true],
  ['ambiguous', true, false]
] as const)(
  'keeps unread markers without dispatching with %s ownership (CLI: %s, automation: %s)',
  (ownership, cliWorktreeTaskComplete, automationWorktreeTaskComplete) => {
    const state = resetNotificationDispatchMockState()
    state.settings.notifications = {
      cliWorktreeTaskComplete,
      automationWorktreeTaskComplete
    }
    if (ownership === 'missing') {
      state.worktreesByRepo = {}
    } else {
      state.worktreesByRepo.repo1[0].hostId = 'local'
      state.worktreesByRepo.repo1.push({
        ...state.worktreesByRepo.repo1[0],
        hostId: 'ssh:server',
        cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
      })
    }
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(state.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(state.markAgentCompletionPaneUnread).toHaveBeenCalledWith(PANE_KEY, 'agent-completion')
    expect(state.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(state.markTerminalPaneUnread).toHaveBeenCalledWith(PANE_KEY, 'agent-completion')
  }
)

it.each(['missing', 'ambiguous'] as const)(
  'dispatches an unresolved completion with %s ownership when neither origin is muted',
  (ownership) => {
    const state = resetNotificationDispatchMockState()
    state.settings.notifications = {
      cliWorktreeTaskComplete: true,
      automationWorktreeTaskComplete: true
    }
    if (ownership === 'missing') {
      state.worktreesByRepo = {}
    } else {
      state.worktreesByRepo.repo1[0].hostId = 'local'
      state.worktreesByRepo.repo1.push({
        ...state.worktreesByRepo.repo1[0],
        hostId: 'ssh:server'
      })
    }
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete', agentState: 'done' })
    )
  }
)

it('dispatches a known ordinary workspace even when both origin preferences are muted', () => {
  const state = resetNotificationDispatchMockState()
  state.settings.notifications = {
    cliWorktreeTaskComplete: false,
    automationWorktreeTaskComplete: false
  }
  dispatchTerminalNotification('wt-primary', {
    source: 'agent-task-complete',
    terminalTitle: 'codex',
    paneKey: PANE_KEY
  })
  expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceOrigin: 'other' })
  )
})

it('preserves input-needed delivery before workspace hydration', () => {
  const state = resetNotificationDispatchMockState()
  state.worktreesByRepo = {}
  state.settings.notifications = {
    cliWorktreeTaskComplete: false,
    automationWorktreeTaskComplete: false
  }
  state.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, { state: 'blocked' })
  dispatchTerminalNotification('wt-primary', {
    source: 'agent-task-complete',
    terminalTitle: 'codex',
    paneKey: PANE_KEY,
    agentStatusSnapshot: state.agentStatusByPaneKey[PANE_KEY]
  })
  expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ agentState: 'blocked' })
  )
})

it('preserves terminal bell delivery before workspace hydration', () => {
  const state = resetNotificationDispatchMockState()
  state.worktreesByRepo = {}
  dispatchTerminalNotification('wt-primary', {
    source: 'terminal-bell',
    terminalTitle: 'shell',
    paneKey: PANE_KEY
  })
  expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ source: 'terminal-bell' })
  )
})
