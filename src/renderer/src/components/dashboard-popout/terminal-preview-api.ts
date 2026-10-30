import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { createPtyInputSourceBinding } from '../terminal-pane/pty-input-source'
import {
  bindRemoteRuntimeTerminalPreview,
  remoteRuntimeTerminalPreviewApi
} from './remote-runtime-terminal-preview-api'

/** A paired host's pane previews from that host; everything else from this app's main process. */
export function terminalPreviewApiFor(ptyId: string): typeof window.api.terminalPreview {
  return isRemoteRuntimePtyId(ptyId) ? remoteRuntimeTerminalPreviewApi : window.api.terminalPreview
}

/** Main's input bridge retains this concrete id through its existing validation/chunk writer. */
export function bindTerminalPreviewApiFor(ptyId: string) {
  if (isRemoteRuntimePtyId(ptyId)) {
    return bindRemoteRuntimeTerminalPreview(ptyId)
  }
  const api = window.api.terminalPreview
  const source = createPtyInputSourceBinding<string>({
    same: (a, b) => a === b,
    refine: (_, next) => next,
    create: (endpoint, isCurrent) => {
      const id = endpoint()
      const write = async (data: string): Promise<boolean> =>
        isCurrent() && (await api.input(id, data)) && isCurrent()
      return {
        ptyId: id,
        isCurrent,
        sendInput: (data) => {
          if (!isCurrent()) {
            return false
          }
          void write(data)
          return true
        },
        sendInputImmediate: (data) => {
          if (!isCurrent()) {
            return false
          }
          void write(data)
          return true
        }
      }
    }
  })
  source.change(ptyId, () => {})
  return {
    ...api,
    getInputSource: source.current,
    observeInputSource: source.observe,
    unsubscribe: async (id: string) => {
      try {
        source.change(null, () => {})
      } finally {
        await api.unsubscribe(id)
      }
    }
  }
}
