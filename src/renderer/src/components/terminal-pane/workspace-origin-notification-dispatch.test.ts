import { afterEach, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { PANE_KEY, resetNotificationDispatchMockState } from './notification-dispatch-test-harness'

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

afterEach(() => vi.unstubAllGlobals())

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
