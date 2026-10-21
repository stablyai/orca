import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  PANE_KEY,
  playDesktopNotificationSound,
  resetNotificationDispatchMockState,
  type NotificationDispatchMockState
} from './notification-dispatch-test-harness'

beforeEach(() => setPresenceGated(false))
afterEach(() => setPresenceGated(true))

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

let mockState: NotificationDispatchMockState

/** Hides wt-primary with "Hide CLI-created" and hydrates the inputs the mute check reads. */
function hideCliCreatedPrimary(notifyHiddenWorkspaces: boolean): void {
  const [primary, secondary] = mockState.worktreesByRepo.repo1
  Object.assign(mockState, {
    persistedUIReady: true,
    workspaceSessionReady: true,
    showSleepingWorkspaces: true,
    hideCliCreatedWorkspaces: true,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    filterRepoIds: [],
    worktreeLineageById: {},
    folderWorkspaces: [],
    worktreesByRepo: {
      repo1: [
        { ...primary, isArchived: false, cliProvenance: { kind: 'created-by-cli', createdAt: 0 } },
        { ...secondary, isArchived: false }
      ]
    }
  })
  mockState.settings.notifications = { ...mockState.settings.notifications, notifyHiddenWorkspaces }
}

function completeTurn(worktreeId: string): void {
  dispatchTerminalNotification(worktreeId, {
    source: 'agent-task-complete',
    terminalTitle: 'codex',
    paneKey: PANE_KEY
  })
}

describe('dispatchTerminalNotification for a workspace hidden by a Filters switch', () => {
  beforeEach(() => {
    mockState = resetNotificationDispatchMockState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends no banner request, plays no sound and marks nothing unread while the setting is off', async () => {
    hideCliCreatedPrimary(false)
    completeTurn('wt-primary')
    await Promise.resolve()
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markAgentAttentionUnread).not.toHaveBeenCalled()
    expect(playDesktopNotificationSound).not.toHaveBeenCalled()
  })

  it('notifies as before when Notify about hidden workspaces is on', async () => {
    hideCliCreatedPrimary(true)
    completeTurn('wt-primary')
    await vi.waitFor(() => expect(playDesktopNotificationSound).toHaveBeenCalled())
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-primary', source: 'agent-task-complete' })
    )
    expect(mockState.markAgentAttentionUnread).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'wt-primary', subjectKey: PANE_KEY })
    )
  })

  it('leaves a bell from a visible workspace untouched', () => {
    hideCliCreatedPrimary(false)
    mockState.tabsByWorktree = { 'wt-secondary': [{ id: 'tab-1', ptyId: 'pty-1' }] }
    mockState.activeWorktreeId = 'wt-primary'
    dispatchTerminalNotification('wt-secondary', { source: 'terminal-bell', paneKey: PANE_KEY })
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-secondary', source: 'terminal-bell' })
    )
  })
})
