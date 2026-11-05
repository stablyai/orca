import {
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup, PendingStartupCommand } from './fresh-spawn-types'

export function isColdRestoreStartup(
  startup: PendingStartupCommand | null | undefined
): startup is ColdRestoreAgentResumeStartup {
  return Boolean(
    startup &&
    'agent' in startup &&
    'resumeProviderSession' in startup &&
    'useLiveEntry' in startup &&
    'sleepingRecordEntry' in startup
  )
}

/** Keeps an existing pane resumable until the agent reports its identity again. */
export function paneResumeRecord(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined
): SleepingAgentSessionRecord | null {
  const coldRestore = isColdRestoreStartup(startupOverride) ? startupOverride : null
  const agent = coldRestore?.agent ?? session.paneStartup?.launchAgent
  const providerSession =
    coldRestore?.resumeProviderSession ?? session.paneStartup?.resumeProviderSession
  if (!agent || !isResumableTuiAgent(agent) || !providerSession) {
    return null
  }
  const launchConfig = coldRestore?.launchConfig ?? session.paneStartup?.launchConfig
  const now = Date.now()
  return {
    paneKey: session.cacheKey,
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    agent,
    providerSession,
    ...(coldRestore?.connectionId !== undefined ? { connectionId: coldRestore.connectionId } : {}),
    prompt: '',
    state: 'done',
    capturedAt: now,
    updatedAt: now,
    ...(launchConfig ? { launchConfig } : {}),
    // Quit origin preserves unfinished existing-pane records during sweeps; completed live bookmarks are passive history.
    origin: 'quit',
    restoreOnTabOpenOnly: true
  }
}
