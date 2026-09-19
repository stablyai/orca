import { makePaneKey } from '../../../../shared/stable-pane-id'
import { scheduleAgentUnsentDraftCheck } from '@/lib/agent-unsent-draft'
import { useAppStore } from '@/store'

export function recordTerminalUserInputForLeaf(tabId: string, leafId: string): void {
  try {
    // Why: hibernation must see all user-authorized terminal writes, including
    // sends that bypass xterm.onData.
    const paneKey = makePaneKey(tabId, leafId)
    useAppStore.getState().recordTerminalInput(paneKey)
    // The same writes are the only thing that can change what the composer holds,
    // so this is where the unsent-draft check belongs; it coalesces per pane.
    scheduleAgentUnsentDraftCheck(paneKey)
  } catch {
    // Legacy/malformed layouts are ignored; hibernation remains conservative
    // when it cannot match live PTYs to stable pane keys.
  }
}
