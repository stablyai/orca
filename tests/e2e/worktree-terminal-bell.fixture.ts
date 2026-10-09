import { vi } from 'vitest'
import { useAppStore } from '../../src/renderer/src/store'
import { capturePassiveWorktreeMetaOwner } from '../../src/renderer/src/store/slices/worktrees/listing/worktree-owner-settings'
import { installPanePtyVisibilityBind } from '../../src/renderer/src/components/terminal-pane/pty-connection/pane-pty-visibility-bind'
import type { ConnectPanePtySession } from '../../src/renderer/src/components/terminal-pane/pty-connection/connect-pane-pty-session'
import type { ExecutionHostId } from '../../src/shared/execution-host'
import type { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'

export function mountedBellSession(
  renderer: ReturnType<typeof createTestStore>,
  id: string,
  hostId: ExecutionHostId,
  runtimeEnvironmentId: string | null = null
) {
  vi.spyOn(useAppStore, 'getState').mockImplementation(renderer.getState)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the installed BEL callback's real Store actions and transport owner; it never invokes pane rendering or connection callbacks.
  const session = {
    deps: {
      worktreeId: id,
      tabId: 'mounted-tab',
      markWorktreeUnread: renderer.getState().markWorktreeUnread,
      markTerminalTabUnread: renderer.getState().markTerminalTabUnread,
      markTerminalPaneUnread: renderer.getState().markTerminalPaneUnread,
      dispatchNotification: vi.fn()
    },
    transport: {
      getExecutionHostId: () => hostId,
      getRuntimeEnvironmentId: () => runtimeEnvironmentId
    },
    worktreeMetadataOwner:
      capturePassiveWorktreeMetaOwner(renderer.getState(), id, {
        executionHostId: hostId,
        runtimeEnvironmentId
      }) ?? null,
    cacheKey: 'mounted-tab:leaf',
    terminalBellNotificationTimer: null,
    agentCompletionCoordinator: { hasPendingHookDoneCompletion: () => true }
  } as unknown as ConnectPanePtySession
  installPanePtyVisibilityBind(session)
  return session
}
