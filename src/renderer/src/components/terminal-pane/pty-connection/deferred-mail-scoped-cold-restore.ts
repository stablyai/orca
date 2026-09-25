import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function deferUnaddressedMailScopedColdRestore(session: ConnectPanePtySession): boolean {
  const sleepingRecordEntry = session.getSleepingRecordForPane(useAppStore.getState())
  if (
    !sleepingRecordEntry ||
    !session.deps.coldRestorePaneKeys ||
    session.deps.coldRestorePaneKeys.has(session.cacheKey)
  ) {
    return false
  }

  session.hibernatedWakeTarget = {
    ptyId: session.deps.restoredPtyIdByLeafId?.[session.pane.leafId] ?? '',
    record: sleepingRecordEntry.record
  }
  if (session.deps.isVisibleRef.current) {
    // A reveal can beat the deferred attach frame and observe no armed target.
    queueMicrotask(() => session.consumeHibernatedAgentWake())
  }
  scheduleRuntimeGraphSync()
  return true
}
