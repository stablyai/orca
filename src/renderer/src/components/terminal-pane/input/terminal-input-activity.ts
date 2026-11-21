import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store/index'
import { noteTerminalWebglAtlasTyping } from '@/lib/pane-manager/terminal-rendering/terminal-webgl-atlas-memory-rebuild'

export function recordTerminalUserInputForLeaf(tabId: string, leafId: string): void {
  noteTerminalWebglAtlasTyping()
  try {
    // Hibernation must observe authorized writes that bypass xterm.onData.
    useAppStore.getState().recordTerminalInput(makePaneKey(tabId, leafId))
  } catch {
    // Ignore malformed pane keys; unmatched PTYs keep hibernation conservative.
  }
}
