import { resetWebRuntimeTerminalInputModes } from '@/runtime/web-runtime-session'
import { resetPtyRendererInputModes } from './pty-buffer-serializer'

/**
 * Reset Terminal: grounds the input modes an app left armed (Kitty keyboard,
 * mouse, bracketed paste, focus, alt screen, cursor keys) in the pane and in the
 * host's models, so a reattach does not re-arm them. Each side grounds its own
 * records; an older host rejects the request and only the pane is grounded.
 */
export function resetTerminalInputModes(ptyId: string | null): void {
  if (!ptyId) {
    return
  }
  resetPtyRendererInputModes(ptyId)
  if (!resetWebRuntimeTerminalInputModes(ptyId)) {
    window.api.pty.resetInputModes(ptyId)
  }
}
