import { installAgentIdleWorkingHandlers } from './agent-idle-working-handlers'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installAgentTaskCompleteNotify(session: ConnectPanePtySession): void {
  installAgentIdleWorkingHandlers(session)
}
