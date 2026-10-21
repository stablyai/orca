// Main's copy of the window's agent resume records in a layout-owner build. Frames do not carry
// them, and the window still captures them from its own agent status, so main records each change.

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
