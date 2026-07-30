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
