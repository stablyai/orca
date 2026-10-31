import { detectAgentStatusFromTitle } from '@/lib/agent-status'

import { REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS } from './foreground-output-scan'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installInterruptInputIntent(session: ConnectPanePtySession): void {
  session.scheduleReattachIdleAgentCursorReset = (): void => {
    const status = detectAgentStatusFromTitle(session.getCurrentTerminalTitle() ?? '')
    if (status !== 'idle' && status !== 'permission') {
      return
    }
    session.clearReattachIdleAgentCursorResetTimer()
    session.reattachIdleAgentCursorResetTimer = setTimeout(() => {
      session.reattachIdleAgentCursorResetTimer = null
      if (session.disposed) {
        return
      }
      const latestStatus = detectAgentStatusFromTitle(session.getCurrentTerminalTitle() ?? '')
      if (latestStatus !== 'idle' && latestStatus !== 'permission') {
        return
      }
      // Reattach repaint can restore a steady cursor while already idle; no later working→idle edge will reset it.
      session.queueAgentIdleTerminalModeReset()
    }, REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS)
  }
}
