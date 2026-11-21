import {
  awaitAgentStatusStartupSnapshot,
  isAgentStatusStartupSnapshotReady
} from '@/hooks/ipc-events/agent-status/agent-status-startup-snapshot'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** Saved agent ownership must settle before a local reattach can choose its resume route. */
export async function isDeferredSessionReattachReady(
  session: ConnectPanePtySession
): Promise<boolean> {
  const generation = session.transportStreamGeneration
  let waited = false
  if (
    !session.runtimeEnvironmentId &&
    !session.buildColdRestoreAgentResumeStartup() &&
    !isAgentStatusStartupSnapshotReady()
  ) {
    waited = true
    await awaitAgentStatusStartupSnapshot()
  }
  return (
    !session.disposed &&
    generation === session.transportStreamGeneration &&
    (!waited || session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport)
  )
}
