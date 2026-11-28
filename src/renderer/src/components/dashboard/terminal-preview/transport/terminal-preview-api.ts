import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { FitHoldMode } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import {
  remotePreviewHoldMode,
  remoteRuntimeTerminalPreviewApi
} from './remote-runtime-terminal-preview-api'

/** A paired host's pane previews from that host; everything else from this app's main process. */
export function terminalPreviewApiFor(ptyId: string): typeof window.api.terminalPreview {
  return isRemoteRuntimePtyId(ptyId) ? remoteRuntimeTerminalPreviewApi : window.api.terminalPreview
}

/** Who holds a previewed terminal's grid, when its host says (a paired host does; this app's main
 *  process does not). */
export function terminalPreviewHoldMode(ptyId: string): FitHoldMode | undefined {
  return isRemoteRuntimePtyId(ptyId) ? remotePreviewHoldMode(ptyId) : undefined
}
