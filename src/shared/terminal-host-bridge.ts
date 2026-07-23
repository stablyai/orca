// IPC contract between the app renderer (embedder) and the isolated
// terminal-host <webview> guest (ORCA_TERMINAL_PROCESS_ISOLATION=1).
// Guest → embedder travels over ipcRenderer.sendToHost; embedder → guest over
// webview.send. Theme objects are passed as JSON strings so neither preload
// nor this module needs an xterm type dependency.
import type { ParsedAgentStatusPayload } from './agent-status-types'

export const TERMINAL_HOST_EVENT_CHANNEL = 'terminal-host:event'
export const TERMINAL_HOST_APPEARANCE_CHANNEL = 'terminal-host:appearance'

export type TerminalHostAppearance = {
  themeJson?: string
  fontFamily: string
  fontSize: number
  lineHeight?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
}

/** Serializable keydown snapshot the embedder re-dispatches on its document. */
export type TerminalHostForwardedKeydown = {
  key: string
  code: string
  keyCode: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

export type TerminalHostEmbedderEvent =
  | { kind: 'spawned'; ptyId: string }
  | { kind: 'agent-status'; ptyId: string; payload: ParsedAgentStatusPayload }
  | { kind: 'title'; ptyId: string; title: string }
  | { kind: 'exit'; ptyId: string }
  | { kind: 'keydown'; init: TerminalHostForwardedKeydown }
