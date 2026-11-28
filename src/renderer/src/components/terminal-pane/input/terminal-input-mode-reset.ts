import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getLocalPtyBackendId } from '../../../../../shared/terminal/pty/lifecycle/pty-backend-id'
import { resetWebRuntimeTerminalInputModes } from '@/runtime/hosted-terminals/actions/web-runtime-terminal-buffer-actions'
import { resetPtyRendererInputModes } from '../snapshots/pty-buffer-serializer'

/** Ground pane and host input modes so reattach cannot revive stale state; older hosts may reject, leaving only the pane reset. */
export function resetTerminalInputModes(ptyId: string | null): void {
  if (!ptyId) {
    return
  }
  if (getLocalPtyBackendId(ptyId) === 'rex') {
    toast.error(
      translate(
        'terminal.rexInputModeResetUnavailable',
        'Terminal reset is not supported by Rex yet.'
      )
    )
    return
  }
  resetPtyRendererInputModes(ptyId)
  if (!resetWebRuntimeTerminalInputModes(ptyId)) {
    window.api.pty.resetInputModes(ptyId)
  }
}
