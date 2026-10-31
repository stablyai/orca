import { holdPaneResumeInPlace } from '@/lib/pane-spawn-deferral-registry'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

/** While `attempt` runs and `isLive`, the pane owns the resume record `startup` came from. */
export function holdInPlaceResumeUntilSettled(
  isLive: () => boolean,
  startup: ColdRestoreAgentResumeStartup | null | undefined,
  attempt: Promise<unknown>
): void {
  const recordEntry = startup?.sleepingRecordEntry
  if (!recordEntry) {
    return
  }
  const release = holdPaneResumeInPlace(recordEntry.paneKey, isLive)
  void attempt.then(release, release)
}
