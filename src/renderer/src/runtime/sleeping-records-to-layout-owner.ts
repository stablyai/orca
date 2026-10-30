// Window still captures agent resume records; main must record every change because layout frames omit them.

import { useAppStore } from '@/store'
import { recordSleepingRecordChangesThroughLayoutOwner } from '@/store/terminals/terminal-sleep-layout-owner'

let following = false

/** After restore, whose records are main's own: from then on main gets each change. */
export function followSleepingRecordsInLayoutOwner(): void {
  // Kept for the document's life, like the window's layout stream.
  if (following) {
    return
  }
  following = true
  useAppStore.subscribe((state, previous) => {
    if (state.sleepingAgentSessionsByPaneKey !== previous.sleepingAgentSessionsByPaneKey) {
      recordSleepingRecordChangesThroughLayoutOwner(
        state,
        previous.sleepingAgentSessionsByPaneKey,
        state.sleepingAgentSessionsByPaneKey
      )
    }
  })
}
