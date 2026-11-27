import { holdPaneResumeInPlace } from '@/components/terminal-pane/session-restore/spawn-deferral/pane-spawn-deferral-registry'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

function holdSessionResume(session: ConnectPanePtySession, paneKey: string): () => void {
  const releaseHold = holdPaneResumeInPlace(paneKey, () => !session.disposed)
  const release = (): void => {
    releaseHold()
    const index = session.waitTeardowns.indexOf(release)
    if (index !== -1) {
      session.waitTeardowns.splice(index, 1)
    }
  }
  session.waitTeardowns.push(release)
  return release
}

/** Each concrete attempt owns any retained conversation, including retries after a refusal. */
export function runPaneResumeAttempt<T>(
  session: ConnectPanePtySession,
  start: () => Promise<T>
): Promise<T> {
  const releaseHold = holdSessionResume(session, session.cacheKey)
  const release = (): void => {
    releaseHold()
    session.deps.releaseResumeInPlace?.()
  }
  try {
    const attempt = start()
    void attempt.then(release, release)
    return attempt
  } catch (error) {
    release()
    throw error
  }
}

/** Reattach also owns the record while deciding whether it needs a fresh spawn. */
export function holdInPlaceResumeUntilSettled(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null | undefined,
  attempt: Promise<unknown>
): void {
  const recordEntry = startup?.sleepingRecordEntry
  if (!recordEntry) {
    return
  }
  const release = holdSessionResume(session, recordEntry.paneKey)
  void attempt.then(release, release)
}
