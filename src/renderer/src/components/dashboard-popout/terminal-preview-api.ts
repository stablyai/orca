import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { remoteRuntimeTerminalPreviewApi } from './remote-runtime-terminal-preview-api'

/** A paired host's pane previews from that host; everything else from this app's main process. */
export function terminalPreviewApiFor(ptyId: string): typeof window.api.terminalPreview {
  return isRemoteRuntimePtyId(ptyId) ? remoteRuntimeTerminalPreviewApi : window.api.terminalPreview
}
