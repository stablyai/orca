import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PendingStartupCommand, ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { PtyConnectResult } from '../pty-transport-types'

export function settleResumeSpawn(
  session: ConnectPanePtySession,
  startup:
    | (PendingStartupCommand & Partial<NonNullable<ConnectPanePtySession['paneStartup']>>)
    | null,
  coldRestore: ColdRestoreAgentResumeStartup | null,
  result: Pick<PtyConnectResult, 'agentResumeUnavailable' | 'exitedBeforeAttach'> | null
): void {
  const checkedClaudeStartup = startup?.launchAgent === 'claude' && startup.resumeProviderSession
  if (result?.exitedBeforeAttach && (checkedClaudeStartup || coldRestore?.agent === 'claude')) {
    session.preserveClaudeResumeRecord = true
    return
  }
  if (result?.agentResumeUnavailable) {
    session.preserveClaudeResumeRecord = true
    session.showSessionRestoredBanner('resume-unavailable')
    return
  }
  if (
    coldRestore?.hasSleepingRecord ||
    (checkedClaudeStartup && startup.showSessionRestoredBanner)
  ) {
    session.showSessionRestoredBanner()
  }
  if (coldRestore || startup?.resumeProviderSession) {
    session.preserveClaudeResumeRecord = false
    session.clearSleepingRecordAfterColdRestoreSpawn(coldRestore)
  }
}
