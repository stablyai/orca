import { useAppStore } from '@/store'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { resolveLatestAgentDoneStartedAt } from '../notifications/agent-done-started-at'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installNativeWindowsPanePolicy(session: ConnectPanePtySession): void {
  session.isNativeWindowsConpty = isLocalNativeWindowsConpty({
    userAgent: navigator.userAgent,
    connectionId: null,
    cwd: session.deps.cwd,
    // Match main’s global-shell classification so default WSL never enables native ConPTY behavior.
    shellOverride: resolveWindowsShellOverride(
      session.shellOverride,
      session.state.settings?.terminalWindowsShell
    ),
    executionHostId: session.executionHostId
  })
  session.shouldApplyNativeWindowsRewriteRefresh = session.isNativeWindowsConpty
  session.shouldApplyWindowsRendererUnicodeRefresh = CLIENT_PLATFORM === 'win32'
  session.shouldProtectNativeWindowsSynchronizedOutput = session.isNativeWindowsConpty
  session.unsubscribeWindowsDoneTerminalModeReset = null
  if (session.isNativeWindowsConpty) {
    const initialAgentStatus = session.state.agentStatusByPaneKey[session.cacheKey]
    let lastAgentDoneStartedAt = resolveLatestAgentDoneStartedAt(initialAgentStatus)
    if (
      !initialAgentStatus &&
      session.paneStartup?.telemetry?.launch_source === 'sidebar' &&
      session.paneStartup.telemetry.request_kind === 'resume' &&
      (session.paneStartup.launchAgent === 'codex' ||
        session.paneStartup.telemetry.agent_kind === 'codex')
    ) {
      // Completed Codex resumes can lack a done row; keep the Windows stale-focus guard until work resumes.
      session.suppressNativeWindowsIdleCodexFocusReports = true
    }
    if (initialAgentStatus?.state === 'done') {
      session.setFocusReportSuppressionForAgentCompletion(undefined, initialAgentStatus.agentType)
    }
    session.unsubscribeWindowsDoneTerminalModeReset = useAppStore.subscribe((nextState) => {
      const nextAgentStatus = nextState.agentStatusByPaneKey[session.cacheKey]
      const nextAgentStatusState = nextAgentStatus?.state
      if (nextAgentStatusState === 'done') {
        session.setFocusReportSuppressionForAgentCompletion(undefined, nextAgentStatus.agentType)
      } else if (nextAgentStatusState) {
        session.suppressNativeWindowsIdleCodexFocusReports = false
      }
      const nextAgentDoneStartedAt = resolveLatestAgentDoneStartedAt(nextAgentStatus)
      // Why: a NEW completed turn — same-state `done` pings keep stateStartedAt, so they no-op.
      if (
        nextAgentDoneStartedAt !== undefined &&
        nextAgentDoneStartedAt !== lastAgentDoneStartedAt
      ) {
        session.queueAgentIdleTerminalModeReset()
      }
      lastAgentDoneStartedAt = nextAgentDoneStartedAt
    })
  }
}
