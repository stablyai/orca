// Why: normalized terminal.subscribe stream events crossing the peerClient IPC
// boundary — decoded once in the main process so the renderer never has to
// parse raw TerminalStreamFrame bytes or the JSON-RPC streaming envelope.
export type PeerTerminalStreamEvent =
  | { type: 'subscribed' }
  | { type: 'snapshot'; kind: 'scrollback' | 'resized'; cols: number; rows: number; data: string }
  | { type: 'output'; data: string }
  | { type: 'resized'; cols: number; rows: number }
  | { type: 'metadata'; cwd: string | null }
  | { type: 'error'; message: string }
  | { type: 'end' }

// Why: the `error` event's message when the host revoked this peer's grant
// mid-stream (runtime-rpc.ts's terminatePeerTerminalStreams) — a stable code
// shared with RemoteTerminalPanel so the client can show a specific reason
// instead of the generic subscribe-failure message.
export const PEER_TERMINAL_GRANT_REVOKED_REASON = 'peer_terminal_grant_revoked'
