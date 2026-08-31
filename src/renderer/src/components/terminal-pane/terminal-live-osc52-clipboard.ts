import { createOsc52OscHandler } from './osc52-clipboard'
import {
  showOsc52ClipboardBlockedToast,
  showOsc52ClipboardFailedToast
} from './osc52-clipboard-toast'

/** Routes live sidechannel writes through the same verified clipboard policy as parsed OSC 52. */
export function createTerminalLiveOsc52ClipboardHandler(
  getSettingEnabled: () => boolean | undefined
): (data: string) => boolean {
  return createOsc52OscHandler({
    getSettingEnabled,
    getReplaying: () => false,
    writeClipboardText: (text) => window.api.ui.writeTerminalClipboardText(text),
    showBlockedWriteToast: showOsc52ClipboardBlockedToast,
    showWriteFailedToast: showOsc52ClipboardFailedToast
  })
}
