import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'

export function recordTerminalUserInputForLeaf(tabId: string, leafId: string): void {
  try {
    // Hibernation must observe authorized writes that bypass xterm.onData.
    useAppStore.getState().recordTerminalInput(makePaneKey(tabId, leafId))
  } catch {
    // Ignore malformed pane keys; unmatched PTYs keep hibernation conservative.
  }
}
