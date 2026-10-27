import { resetWebRuntimeTerminalInputModes } from '@/runtime/web-runtime-terminal-buffer-actions'
import { resetPtyRendererInputModes } from './pty-buffer-serializer'

/** Ground pane and host input modes so reattach cannot revive stale state; older hosts may reject, leaving only the pane reset. */
export function resetTerminalInputModes(ptyId: string | null): void {
  if (!ptyId) {
    return
  }
  resetPtyRendererInputModes(ptyId)
  if (!resetWebRuntimeTerminalInputModes(ptyId)) {
    window.api.pty.resetInputModes(ptyId)
  }
}
